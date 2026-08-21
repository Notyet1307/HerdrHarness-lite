import type { HarnessConfig } from "../ports.js";

export type ProjectFileConfig = HarnessConfig & {
  stateDir: string;
  herdr: { bin?: string; session: string };
  analyst: { command: string; argv?: string[] };
};

export type FleetRestartPolicy = {
  initialBackoffMs: number;
  maxBackoffMs: number;
  maxRestarts: number;
  windowMs: number;
  stableAfterMs: number;
};

export type FleetProjectDeclaration = {
  id: string;
  config: string;
  enabled?: boolean;
  pollMs?: number;
};

export type FleetConfigFile = {
  version: 1;
  name?: string;
  stateDir: string;
  defaultPollMs?: number;
  tickConcurrency?: number;
  tickTimeoutMs?: number;
  shutdownGraceMs?: number;
  maxLogBytes?: number;
  restartPolicy?: Partial<FleetRestartPolicy>;
  projects: FleetProjectDeclaration[];
};

export type LoadedFleetProject = {
  id: string;
  configPath: string;
  configDigest: string;
  enabled: boolean;
  pollMs: number;
  config: ProjectFileConfig;
};

export type LoadedFleetConfig = {
  version: 1;
  sourcePath: string;
  name: string;
  stateDir: string;
  defaultPollMs: number;
  tickConcurrency: number;
  tickTimeoutMs: number;
  shutdownGraceMs: number;
  maxLogBytes: number;
  restartPolicy: FleetRestartPolicy;
  projects: LoadedFleetProject[];
  digest: string;
};

export type FleetProjectPhase =
  | "pending"
  | "starting"
  | "running"
  | "adopted"
  | "backoff"
  | "tripped"
  | "stopping"
  | "stopped"
  | "disabled"
  | "unselected"
  | "error";

export type FleetExitRecord = {
  code: number | null;
  signal: string | null;
  exitedAt: string;
  runtimeMs: number;
};

export type FleetProjectRuntime = {
  id: string;
  configDigest: string;
  phase: FleetProjectPhase;
  pid: number | null;
  owned: boolean;
  startedAt: string | null;
  nextStartAt: string | null;
  restartTimestamps: string[];
  lastExit: FleetExitRecord | null;
  lastError: string | null;
};

export type FleetRuntimeState = {
  version: 1;
  fleetName: string;
  configDigest: string;
  supervisorPid: number;
  startedAt: string;
  updatedAt: string;
  stopping: boolean;
  projects: Record<string, FleetProjectRuntime>;
};

export type ProjectTickResult = {
  projectId: string;
  ok: boolean;
  code: number | null;
  signal: string | null;
  startedAt: string;
  completedAt: string;
  stdout: string;
  stderr: string;
  error: string | null;
};

export type FleetTickReport = {
  version: 1;
  fleet: string;
  startedAt: string;
  completedAt: string;
  concurrency: number;
  ok: boolean;
  projects: ProjectTickResult[];
};
