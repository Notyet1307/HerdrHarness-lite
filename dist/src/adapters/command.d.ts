export type CommandResult = {
    ok: boolean;
    code: number | null;
    stdout: string;
    stderr: string;
    error: string | null;
};
export interface CommandRunner {
    run(command: string, args: string[], options?: {
        cwd?: string;
        input?: string;
        timeoutMs?: number;
        env?: Record<string, string | undefined>;
    }): CommandResult;
}
export declare class SyncCommandRunner implements CommandRunner {
    run(command: string, args: string[], options?: {
        cwd?: string;
        input?: string;
        timeoutMs?: number;
        env?: Record<string, string | undefined>;
    }): CommandResult;
}
export declare function requireSuccess(result: CommandResult, label: string): string;
