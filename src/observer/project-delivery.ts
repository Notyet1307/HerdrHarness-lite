import { spawnSync } from "node:child_process";
import { JsonStateStore } from "../adapters/json-store.js";
import { operatorActionsFor } from "../policy.js";
import {
  removeProjectOutboxEntry,
  saveProjectObserverState,
  type ProjectObserverStateV3,
  type ProjectOutboxEntry,
} from "./project-state.js";
import { scheduleObserverRetry } from "./retry.js";

export type ProjectDeliveryConfig = {
  observerConfigPath: string;
  observerState: string;
  harnessStateDir: string;
  nodeBin: string;
  approvalScript: string;
  deliveryCommand: string[];
};

export async function flushProjectOutbox(config: ProjectDeliveryConfig, state: ProjectObserverStateV3): Promise<void> {
  for (;;) {
    const entry = state.outbox.find((candidate) => candidate.nextAttemptAt <= Date.now());
    if (!entry) return;
    let payload: unknown;
    if (entry.kind === "approval") {
      const ledger = await new JsonStateStore(config.harnessStateDir).load();
      const job = ledger.activeJob;
      const option = job ? operatorActionsFor(job).find((candidate) => candidate.kind === "approve_retry") : null;
      if (job?.state !== "blocked" || job.analysis?.id !== entry.analysisId || job.analysis.incidentId !== job.incident?.id
        || option?.effect !== job.analysis.action) {
        removeProjectOutboxEntry(state, entry);
        saveProjectObserverState(config.observerState, state);
        continue;
      }
      const requested = spawnSync(config.nodeBin, [
        config.approvalScript,
        "request",
        "--config",
        config.observerConfigPath,
        "--json",
        "--transport-v2",
      ], { encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 });
      payload = requested.status === 0 ? parseApprovalEnvelope(requested.stdout, entry.analysisId) : null;
      if (!payload) {
        retry(config, state, entry, "approval_challenge_failed");
        return;
      }
    } else {
      payload = entry.payload;
    }
    const sent = spawnSync(config.deliveryCommand[0]!, config.deliveryCommand.slice(1), {
      encoding: "utf8",
      input: JSON.stringify(payload),
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    });
    if (sent.status === 0) {
      removeProjectOutboxEntry(state, entry);
      saveProjectObserverState(config.observerState, state);
      process.stdout.write(`${JSON.stringify({ ok: true, action: "notification_sent", key: entry.key })}\n`);
      continue;
    }
    retry(config, state, entry, "delivery_failed");
    return;
  }
}

function parseApprovalEnvelope(output: string, analysisId: string): unknown | null {
  try {
    const value = JSON.parse(output) as Record<string, unknown>;
    const envelope = value.envelope as Record<string, unknown> | undefined;
    return value.ok === true && value.action === "challenge_created" && value.analysisId === analysisId
      && envelope?.version === 2 && envelope.kind === "event" && envelope.category === "operator.approval"
      ? envelope
      : null;
  } catch {
    return null;
  }
}

function retry(
  config: ProjectDeliveryConfig,
  state: ProjectObserverStateV3,
  entry: ProjectOutboxEntry,
  code: string,
): void {
  scheduleObserverRetry(entry);
  saveProjectObserverState(config.observerState, state);
  process.stderr.write(`${JSON.stringify({ ok: false, action: "notification_retry", key: entry.key, attempts: entry.attempts, code })}\n`);
}
