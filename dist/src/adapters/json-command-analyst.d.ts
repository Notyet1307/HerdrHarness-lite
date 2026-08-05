import { type AnalystSession, type AnalystTurn, type TaskSnapshot } from "../model.js";
import type { AnalystPort } from "../ports.js";
import { type CommandRunner } from "./command.js";
/**
 * Adapter boundary for a persistent Codex wrapper.
 *
 * The configured program receives one JSON request on stdin and returns one
 * JSON object on stdout. It may internally use Codex sessions, but Harness does
 * not depend on unstable Codex CLI flags or grant it controller authority.
 */
export declare class JsonCommandAnalyst implements AnalystPort {
    private readonly command;
    private readonly argv;
    private readonly runner;
    constructor(command: string, argv?: string[], runner?: CommandRunner);
    start(input: {
        jobId: string;
        task: TaskSnapshot;
    }): Promise<AnalystSession>;
    turn(input: Parameters<AnalystPort["turn"]>[0]): Promise<AnalystTurn>;
    close(input: Parameters<AnalystPort["close"]>[0]): Promise<void>;
    private call;
}
export declare function parseAnalystTurn(value: unknown): AnalystTurn;
