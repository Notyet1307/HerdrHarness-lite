import type { RuntimePreflightPort } from "../ports.js";
import { type CommandRunner } from "./command.js";
export declare class RuntimePreflightCli implements RuntimePreflightPort {
    private readonly runner;
    private readonly environment;
    constructor(runner?: CommandRunner, environment?: Record<string, string | undefined>);
    inspectPi(input: {
        cwd: string;
        piBin: string;
    }): Promise<{
        executable: string;
        version: string;
    }>;
    assertNoAmbientSystemPrompt(input: {
        cwd: string;
    }): Promise<{
        agentDir: string;
    }>;
    probeProvider(input: {
        lane: "worker" | "reviewer";
        cwd: string;
        roleArgv: string[];
        piBin: string;
        agentDir?: string;
    }): Promise<void>;
    probeDocker(input: {
        cwd: string;
    }): Promise<{
        host: string;
    }>;
}
