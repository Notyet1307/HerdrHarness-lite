import type { AnalystSession, AnalystTurn, TaskSnapshot } from "../model.js";
import type { AnalystPort } from "../ports.js";
import { type CommandRunner, requireSuccess, SyncCommandRunner } from "./command.js";

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
    if (typeof response.sessionId !== "string" || typeof response.agentName !== "string") {
      throw new Error("Codex Analyst wrapper returned incomplete session identity");
    }
    return {
      id: response.sessionId,
      agentName: response.agentName,
      startedAt: typeof response.startedAt === "string" ? response.startedAt : new Date().toISOString(),
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
        need_evidence: ["issue_context", "git_status", "git_diff", "test_output", "attempt_result", "file_excerpt"],
        advice: ["retry_fresh_worker", "hold"],
      },
    });
    return parseTurn(response);
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

function parseTurn(value: unknown): AnalystTurn {
  if (!value || typeof value !== "object") throw new Error("Analyst turn is not an object");
  const object = value as Record<string, unknown>;
  if (object.kind === "need_evidence") {
    if (!Array.isArray(object.requests)) throw new Error("Analyst evidence requests are invalid");
    return {
      kind: "need_evidence",
      requests: object.requests.map((request) => {
        if (!request || typeof request !== "object") throw new Error("Analyst evidence request is invalid");
        const item = request as Record<string, unknown>;
        if (
          !["issue_context", "git_status", "git_diff", "test_output", "attempt_result", "file_excerpt"].includes(
            String(item.kind),
          ) ||
          typeof item.reason !== "string"
        ) {
          throw new Error("Analyst requested an unsupported evidence operation");
        }
        return {
          kind: item.kind as "issue_context" | "git_status" | "git_diff" | "test_output" | "attempt_result" | "file_excerpt",
          path: typeof item.path === "string" ? item.path : null,
          reason: item.reason,
        };
      }),
    };
  }
  if (object.kind !== "advice") throw new Error("Analyst turn kind is invalid");
  if (
    (object.action !== "retry_fresh_worker" && object.action !== "hold") ||
    typeof object.summary !== "string" ||
    typeof object.resolutionBrief !== "string" ||
    !Array.isArray(object.evidenceRefs) ||
    !Array.isArray(object.unknowns)
  ) {
    throw new Error("Analyst advice is invalid");
  }
  return {
    kind: "advice",
    action: object.action,
    summary: object.summary,
    resolutionBrief: object.resolutionBrief,
    evidenceRefs: object.evidenceRefs.filter((entry): entry is string => typeof entry === "string"),
    unknowns: object.unknowns.filter((entry): entry is string => typeof entry === "string"),
  };
}
