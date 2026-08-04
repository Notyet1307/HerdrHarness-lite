declare const process: {
  argv: string[];
  cwd(): string;
  env: Record<string, string | undefined>;
  stdout: { write(value: string): void };
  stderr: { write(value: string): void };
  exitCode?: number;
};

declare const console: {
  log(...values: unknown[]): void;
  error(...values: unknown[]): void;
};

declare module "node:crypto" {
  export function randomUUID(): string;
  export function createHash(name: string): {
    update(value: string): unknown;
    digest(encoding: "hex"): string;
  };
}

declare module "node:child_process" {
  export interface SpawnSyncReturns<T> {
    status: number | null;
    stdout: T;
    stderr: T;
    error?: Error;
  }
  export function spawnSync(
    command: string,
    args?: readonly string[],
    options?: {
      cwd?: string;
      encoding?: "utf8";
      timeout?: number;
      maxBuffer?: number;
      input?: string;
      env?: Record<string, string | undefined>;
    },
  ): SpawnSyncReturns<string>;
}

declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string, options?: { encoding?: "utf8"; mode?: number }): void;
  export function appendFileSync(path: string, data: string, options?: { encoding?: "utf8"; mode?: number }): void;
  export function renameSync(oldPath: string, newPath: string): void;
  export function rmSync(path: string, options?: { force?: boolean; recursive?: boolean }): void;
  export function openSync(path: string, flags: string, mode?: number): number;
  export function closeSync(fd: number): void;
  export function unlinkSync(path: string): void;
}

declare module "node:path" {
  export function dirname(path: string): string;
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
}

declare module "node:test" {
  export interface TestContext {
    name: string;
  }
  export default function test(
    name: string,
    fn: (context: TestContext) => void | Promise<void>,
  ): void;
}

declare module "node:assert/strict" {
  interface Assert {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    match(value: string, regexp: RegExp, message?: string): void;
    rejects(block: () => Promise<unknown>, error?: RegExp | ((error: unknown) => boolean)): Promise<void>;
    throws(block: () => unknown, error?: RegExp | ((error: unknown) => boolean)): void;
  }
  const assert: Assert;
  export default assert;
}
