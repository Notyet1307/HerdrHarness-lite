import { requireSuccess, SyncCommandRunner } from "./command.js";
/**
 * Adapter boundary for a persistent Codex wrapper.
 *
 * The configured program receives one JSON request on stdin and returns one
 * JSON object on stdout. It may internally use Codex sessions, but Harness does
 * not depend on unstable Codex CLI flags or grant it controller authority.
 */
export class JsonCommandAnalyst {
    command;
    argv;
    runner;
    constructor(command, argv = [], runner = new SyncCommandRunner()) {
        this.command = command;
        this.argv = argv;
        this.runner = runner;
    }
    async start(input) {
        const response = this.call({ operation: "start", jobId: input.jobId, task: input.task });
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
    async turn(input) {
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
    call(payload) {
        const result = this.runner.run(this.command, this.argv, {
            input: `${JSON.stringify(payload)}\n`,
            timeoutMs: 120_000,
        });
        const stdout = requireSuccess(result, "Codex Analyst wrapper");
        return JSON.parse(stdout);
    }
}
function parseTurn(value) {
    if (!value || typeof value !== "object")
        throw new Error("Analyst turn is not an object");
    const object = value;
    if (object.kind === "need_evidence") {
        if (!Array.isArray(object.requests))
            throw new Error("Analyst evidence requests are invalid");
        return {
            kind: "need_evidence",
            requests: object.requests.map((request) => {
                if (!request || typeof request !== "object")
                    throw new Error("Analyst evidence request is invalid");
                const item = request;
                if (!["issue_context", "git_status", "git_diff", "test_output", "attempt_result", "file_excerpt"].includes(String(item.kind)) ||
                    typeof item.reason !== "string") {
                    throw new Error("Analyst requested an unsupported evidence operation");
                }
                return {
                    kind: item.kind,
                    path: typeof item.path === "string" ? item.path : null,
                    reason: item.reason,
                };
            }),
        };
    }
    if (object.kind !== "advice")
        throw new Error("Analyst turn kind is invalid");
    if ((object.action !== "retry_fresh_worker" && object.action !== "hold") ||
        typeof object.summary !== "string" ||
        typeof object.resolutionBrief !== "string" ||
        !Array.isArray(object.evidenceRefs) ||
        !Array.isArray(object.unknowns)) {
        throw new Error("Analyst advice is invalid");
    }
    return {
        kind: "advice",
        action: object.action,
        summary: object.summary,
        resolutionBrief: object.resolutionBrief,
        evidenceRefs: object.evidenceRefs.filter((entry) => typeof entry === "string"),
        unknowns: object.unknowns.filter((entry) => typeof entry === "string"),
    };
}
//# sourceMappingURL=json-command-analyst.js.map