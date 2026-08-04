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
        if (!codexUuid(response.sessionId) ||
            !boundedText(response.agentName, 512) ||
            typeof response.startedAt !== "string" ||
            !Number.isFinite(Date.parse(response.startedAt))) {
            throw new Error("Codex Analyst wrapper returned invalid session identity");
        }
        return {
            id: response.sessionId,
            agentName: response.agentName,
            startedAt: response.startedAt,
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
        return parseAnalystTurn(response);
    }
    async close(input) {
        const response = this.call({ operation: "close", ...input });
        if (!response || typeof response !== "object") {
            throw new Error("Codex Analyst wrapper returned an invalid close response");
        }
        const output = response;
        const valid = input.session
            ? output.status === "closed" && output.sessionId === input.session.id
            : output.status === "noop" || (output.status === "closed" && codexUuid(output.sessionId));
        if (!valid)
            throw new Error("Codex Analyst wrapper returned an invalid close response");
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
export function parseAnalystTurn(value) {
    if (!value || typeof value !== "object")
        throw new Error("Analyst turn is not an object");
    const object = value;
    if (object.kind === "need_evidence") {
        if (!Array.isArray(object.requests) || object.requests.length === 0 || object.requests.length > 4) {
            throw new Error("Analyst evidence requests are invalid");
        }
        return {
            kind: "need_evidence",
            requests: object.requests.map((request) => {
                if (!request || typeof request !== "object")
                    throw new Error("Analyst evidence request is invalid");
                const item = request;
                if (!["issue_context", "git_status", "git_diff", "test_output", "attempt_result", "file_excerpt"].includes(String(item.kind)) ||
                    !boundedText(item.reason, 512) ||
                    (item.path !== null && item.path !== undefined && !boundedText(item.path, 512))) {
                    throw new Error("Analyst requested an unsupported evidence operation");
                }
                return {
                    kind: item.kind,
                    path: boundedText(item.path, 512) ? item.path : null,
                    reason: item.reason,
                };
            }),
        };
    }
    if (object.kind !== "advice")
        throw new Error("Analyst turn kind is invalid");
    if ((object.action !== "retry_fresh_worker" && object.action !== "hold") ||
        !boundedText(object.summary, 2_000) ||
        typeof object.resolutionBrief !== "string" || object.resolutionBrief.length > 2_000 || object.resolutionBrief.includes("\u0000") ||
        !Array.isArray(object.evidenceRefs) ||
        object.evidenceRefs.length === 0 || object.evidenceRefs.length > 8 ||
        !object.evidenceRefs.every((entry) => boundedText(entry, 128)) ||
        new Set(object.evidenceRefs).size !== object.evidenceRefs.length ||
        !Array.isArray(object.unknowns) || object.unknowns.length > 4 ||
        !object.unknowns.every((entry) => boundedText(entry, 512))) {
        throw new Error("Analyst advice is invalid");
    }
    return {
        kind: "advice",
        action: object.action,
        summary: object.summary,
        resolutionBrief: object.resolutionBrief,
        evidenceRefs: object.evidenceRefs,
        unknowns: object.unknowns,
    };
}
function boundedText(value, max) {
    return typeof value === "string" && value.trim().length > 0 && value.length <= max && !value.includes("\u0000");
}
function codexUuid(value) {
    return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
//# sourceMappingURL=json-command-analyst.js.map