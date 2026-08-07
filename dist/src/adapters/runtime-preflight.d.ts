import type { RuntimePreflightPort } from "../ports.js";
import { type CommandRunner } from "./command.js";
export declare class RuntimePreflightCli implements RuntimePreflightPort {
    private readonly runner;
    private readonly environment;
    constructor(runner?: CommandRunner, environment?: Record<string, string | undefined>);
    probeProvider(input: {
        lane: "worker" | "reviewer";
        cwd: string;
        roleArgv: string[];
        piBin: string;
    }): Promise<void>;
    probeDocker(input: {
        cwd: string;
    }): Promise<{
        host: string;
    }>;
}
