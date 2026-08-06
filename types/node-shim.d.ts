declare const process: {
  argv: string[];
  execPath: string;
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

interface ImportMeta {
  dirname: string;
}

declare module "node:crypto" {
  export function randomUUID(): string;
  export function createHash(name: string): {
    update(value: string): unknown;
    digest(encoding: "hex"): string;
  };
}

declare module "node:buffer" {
  export const Buffer: {
    from(value: string, encoding: "utf8" | "base64url"): { toString(encoding: "utf8" | "base64url"): string };
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
  export function chmodSync(path: string, mode: number): void;
  export function cpSync(source: string, destination: string, options?: { recursive?: boolean }): void;
  export function existsSync(path: string): boolean;
  export function fsyncSync(fd: number): void;
  export function mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): string | undefined;
  export function mkdtempSync(prefix: string): string;
  export function readFileSync(path: string | number, encoding: "utf8"): string;
  export function readdirSync(path: string): string[];
  export function lstatSync(path: string): {
    mode: number;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  };
  export function realpathSync(path: string): string;
  export function writeFileSync(
    path: string,
    data: string,
    options?: { encoding?: "utf8"; mode?: number; flag?: string; flush?: boolean },
  ): void;
  export function appendFileSync(path: string, data: string, options?: { encoding?: "utf8"; mode?: number }): void;
  export function renameSync(oldPath: string, newPath: string): void;
  export function rmSync(path: string, options?: { force?: boolean; recursive?: boolean }): void;
  export function openSync(path: string, flags: string, mode?: number): number;
  export function closeSync(fd: number): void;
  export function unlinkSync(path: string): void;
  export function linkSync(existingPath: string, newPath: string): void;
  export function symlinkSync(target: string, path: string, type?: "dir" | "file" | "junction"): void;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:url" {
  export function pathToFileURL(path: string): { href: string };
}

declare module "node:path" {
  export const sep: string;
  export function basename(path: string): string;
  export function dirname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function join(...parts: string[]): string;
  export function relative(from: string, to: string): string;
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
