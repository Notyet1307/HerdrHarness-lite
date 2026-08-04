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
    }): CommandResult;
}
export declare class SyncCommandRunner implements CommandRunner {
    run(command: string, args: string[], options?: {
        cwd?: string;
        input?: string;
        timeoutMs?: number;
    }): CommandResult;
}
export declare function requireSuccess(result: CommandResult, label: string): string;
