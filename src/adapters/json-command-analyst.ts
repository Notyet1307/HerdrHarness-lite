import { isBoundedText as boundedText, type AnalystDiagnosis, type AnalystSession, type AnalystTurn, type EvidenceRequestKind, type TaskSnapshot } from "../model.js";
import type { AnalystPort } from "../ports.js";
import { type CommandRunner, requireSuccess, SyncCommandRunner } from "./command.js";

export const MAX_ANALYST_UNKNOWNS = 4;
export const MAX_ANALYST_HYPOTHESES = 5;
const EVIDENCE_REQUEST_KINDS: EvidenceRequestKind[] = [
  "issue_context",
  "git_status",
  "git_diff",
  "worktree_progress",
  "test_output",
  "attempt_result",
  "attempt_runtime",
  "attempt_history",
  "controller_health",
  "file_excerpt",
];

/**
 * Adapter boundary for a persistent Codex wrapper.
 *
 * The configured program receives one JSON request on stdin and returns one
 * JSON object on stdout. It may internally use Codex sessions, but Harness does
 * not depend on unstable Codex CLI flags or grant it controller authority.
 */
export class JsonCommandAnalyst implements AnalystPort {
  constructor(
    private readonly command: string,
    private readonly argv: string[] = [],
    private readonly runner: CommandRunner = new SyncCommandRunner(),
  ) {}

  async start(input: { jobId: string; task: TaskSnapshot }): Promise<AnalystSession> {
    const response = this.call({ operation: "start", jobId: input.jobId, task: input.task }) as {
      sessionId?: unknown;
      agentName?: unknown;
      startedAt?: unknown;
    };
    if (
      !codexUuid(response.sessionId) ||
      !boundedText(response.agentName, 512) ||
      typeof response.startedAt !== "string" ||
      !Number.isFinite(Date.parse(response.startedAt))
    ) {
      throw new Error("Codex Analyst wrapper returned invalid session identity");
    }
    return {
      id: response.sessionId,
      agentName: response.agentName,
      startedAt: response.startedAt,
      taskDigest: input.task.digest,
    };
  }

  async turn(input: Parameters<AnalystPort["turn"]>[0]): Promise<AnalystTurn> {
    const response = this.call({
      operation: "turn",
      session: input.session,
      job: {
        id: input.job.id,
        revision: input.job.revision,
        state: input.job.state,
        task: input.job.task,
        incident: input.job.incident,
      },
      evidence: input.evidence,
      turn: input.turn,
      allowedOutput: {
        need_evidence: EVIDENCE_REQUEST_KINDS,
        advice: ["retry_fresh_worker", "retry_fresh_reviewer", "hold"],
      },
    });
    return parseAnalystTurn(response);
  }

  async close(input: Parameters<AnalystPort["close"]>[0]): Promise<void> {
    const response = this.call({ operation: "close", ...input });
    if (!response || typeof response !== "object") {
      throw new Error("Codex Analyst wrapper returned an invalid close response");
    }
    const output = response as Record<string, unknown>;
    const valid = input.session
      ? output.status === "closed" && output.sessionId === input.session.id
      : output.status === "noop" || (output.status === "closed" && codexUuid(output.sessionId));
    if (!valid) throw new Error("Codex Analyst wrapper returned an invalid close response");
  }

  private call(payload: unknown): unknown {
    const result = this.runner.run(this.command, this.argv, {
      input: `${JSON.stringify(payload)}\n`,
      timeoutMs: 120_000,
    });
    const stdout = requireSuccess(result, "Codex Analyst wrapper");
    return JSON.parse(stdout) as unknown;
  }
}

export function parseAnalystTurn(value: unknown): AnalystTurn {
  if (!value || typeof value !== "object") throw new Error("Analyst turn is not an object");
  const object = value as Record<string, unknown>;
  if (object.kind === "need_evidence") {
    if (!Array.isArray(object.requests) || object.requests.length === 0 || object.requests.length > 4) {
      throw new Error("Analyst evidence requests are invalid");
    }
    return {
      kind: "need_evidence",
      requests: object.requests.map((request) => {
        if (!request || typeof request !== "object") throw new Error("Analyst evidence request is invalid");
        const item = request as Record<string, unknown>;
        if (
          !EVIDENCE_REQUEST_KINDS.includes(item.kind as EvidenceRequestKind) ||
          !boundedText(item.reason, 512) ||
          (item.path !== null && item.path !== undefined && !boundedText(item.path, 512))
        ) {
          throw new Error("Analyst requested an unsupported evidence operation");
        }
        return {
          kind: item.kind as EvidenceRequestKind,
          path: boundedText(item.path, 512) ? item.path : null,
          reason: item.reason,
        };
      }),
    };
  }
  if (object.kind !== "advice") throw new Error("Analyst turn kind is invalid");
  if (
    (object.action !== "retry_fresh_worker" && object.action !== "retry_fresh_reviewer" && object.action !== "hold") ||
    !boundedText(object.summary, 2_000) ||
    typeof object.resolutionBrief !== "string" || object.resolutionBrief.length > 2_000 || object.resolutionBrief.includes("\u0000") ||
    !Array.isArray(object.evidenceRefs) ||
    object.evidenceRefs.length === 0 || object.evidenceRefs.length > 8 ||
    !object.evidenceRefs.every((entry) => boundedText(entry, 128)) ||
    new Set(object.evidenceRefs).size !== object.evidenceRefs.length ||
    !Array.isArray(object.unknowns) || object.unknowns.length > MAX_ANALYST_UNKNOWNS ||
    !object.unknowns.every((entry) => boundedText(entry, 512))
  ) {
    throw new Error("Analyst advice is invalid");
  }
  return {
    kind: "advice",
    action: object.action,
    summary: object.summary,
    resolutionBrief: object.resolutionBrief,
    evidenceRefs: object.evidenceRefs as string[],
    unknowns: object.unknowns as string[],
    ...(object.diagnosis === undefined ? {} : { diagnosis: parseDiagnosis(object.diagnosis) }),
  };
}

function parseDiagnosis(value: unknown): AnalystDiagnosis {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Analyst diagnosis is invalid");
  const object = value as Record<string, unknown>;
  if (
    !boundedText(object.primaryCause, 2_000)
    || !["high", "medium", "low"].includes(String(object.confidence))
    || !boundedTextArray(object.contributingFactors, 4, 512)
    || !boundedTextArray(object.preservationConstraints, 4, 512)
  ) throw new Error("Analyst diagnosis is invalid");
  if (!Array.isArray(object.hypotheses)) throw new Error("Analyst diagnosis hypotheses are invalid");
  if (object.hypotheses.length === 0 || object.hypotheses.length > MAX_ANALYST_HYPOTHESES) {
    throw new Error(
      `Analyst diagnosis hypotheses contain ${object.hypotheses.length} entries; expected between 1 and ${MAX_ANALYST_HYPOTHESES}`,
    );
  }
  const hypotheses = object.hypotheses.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Analyst diagnosis hypothesis is invalid");
    const hypothesis = value as Record<string, unknown>;
    if (
      !boundedText(hypothesis.claim, 512)
      || !["supported", "rejected", "unresolved"].includes(String(hypothesis.status))
      || !["high", "medium", "low"].includes(String(hypothesis.confidence))
      || !Array.isArray(hypothesis.evidenceRefs)
      || hypothesis.evidenceRefs.length > 8
      || !hypothesis.evidenceRefs.every((entry) => boundedText(entry, 128))
      || new Set(hypothesis.evidenceRefs).size !== hypothesis.evidenceRefs.length
    ) throw new Error("Analyst diagnosis hypothesis is invalid");
    return {
      claim: hypothesis.claim as string,
      status: hypothesis.status as "supported" | "rejected" | "unresolved",
      confidence: hypothesis.confidence as "high" | "medium" | "low",
      evidenceRefs: hypothesis.evidenceRefs as string[],
    };
  });
  return {
    primaryCause: object.primaryCause as string,
    confidence: object.confidence as "high" | "medium" | "low",
    contributingFactors: object.contributingFactors as string[],
    preservationConstraints: object.preservationConstraints as string[],
    hypotheses,
  };
}

function boundedTextArray(value: unknown, maxItems: number, maxLength: number): value is string[] {
  return Array.isArray(value)
    && value.length <= maxItems
    && value.every((entry) => boundedText(entry, maxLength));
}

function codexUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
