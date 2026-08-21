import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { digest } from "../model.js";
import { validateHarnessConfig } from "../controller/config-validation.js";
import { validateFleetIsolation } from "./isolation.js";
import type {
  FleetConfigFile,
  FleetRestartPolicy,
  LoadedFleetConfig,
  LoadedFleetProject,
  ProjectFileConfig,
} from "./types.js";

const DEFAULT_RESTART_POLICY: FleetRestartPolicy = {
  initialBackoffMs: 1_000,
  maxBackoffMs: 60_000,
  maxRestarts: 5,
  windowMs: 300_000,
  stableAfterMs: 120_000,
};

export function loadFleetConfig(path: string): LoadedFleetConfig {
  const sourcePath = resolve(path);
  const baseDir = dirname(sourcePath);
  const raw = parseJson<FleetConfigFile>(sourcePath, "Fleet config");
  assertAllowedKeys(raw, ["version", "name", "stateDir", "defaultPollMs", "tickConcurrency", "tickTimeoutMs", "shutdownGraceMs", "maxLogBytes", "restartPolicy", "projects"], "Fleet config");
  if (raw.restartPolicy !== undefined) {
    if (!raw.restartPolicy || typeof raw.restartPolicy !== "object" || Array.isArray(raw.restartPolicy)) {
      throw new Error("restartPolicy must be an object");
    }
    assertAllowedKeys(raw.restartPolicy, ["initialBackoffMs", "maxBackoffMs", "maxRestarts", "windowMs", "stableAfterMs"], "restartPolicy");
  }
  if (raw.version !== 1) throw new Error("invalid Fleet config: version must be 1");
  if (!Array.isArray(raw.projects) || raw.projects.length < 1 || raw.projects.length > 64) {
    throw new Error("invalid Fleet config: projects must contain 1 to 64 entries");
  }
  const name = boundedId(raw.name ?? "herdr-fleet", "Fleet name");
  const stateDir = absoluteOrResolve(raw.stateDir, baseDir, "Fleet stateDir");
  const defaultPollMs = boundedInteger(raw.defaultPollMs ?? 15_000, 100, 3_600_000, "defaultPollMs");
  const tickConcurrency = boundedInteger(raw.tickConcurrency ?? 4, 1, 64, "tickConcurrency");
  const tickTimeoutMs = boundedInteger(raw.tickTimeoutMs ?? 600_000, 1_000, 3_600_000, "tickTimeoutMs");
  const shutdownGraceMs = boundedInteger(raw.shutdownGraceMs ?? 15_000, 100, 300_000, "shutdownGraceMs");
  const maxLogBytes = boundedInteger(raw.maxLogBytes ?? 65_536, 4_096, 1_048_576, "maxLogBytes");
  const restartPolicy: FleetRestartPolicy = {
    initialBackoffMs: boundedInteger(raw.restartPolicy?.initialBackoffMs ?? DEFAULT_RESTART_POLICY.initialBackoffMs, 100, 3_600_000, "restartPolicy.initialBackoffMs"),
    maxBackoffMs: boundedInteger(raw.restartPolicy?.maxBackoffMs ?? DEFAULT_RESTART_POLICY.maxBackoffMs, 100, 86_400_000, "restartPolicy.maxBackoffMs"),
    maxRestarts: boundedInteger(raw.restartPolicy?.maxRestarts ?? DEFAULT_RESTART_POLICY.maxRestarts, 0, 100, "restartPolicy.maxRestarts"),
    windowMs: boundedInteger(raw.restartPolicy?.windowMs ?? DEFAULT_RESTART_POLICY.windowMs, 100, 86_400_000, "restartPolicy.windowMs"),
    stableAfterMs: boundedInteger(raw.restartPolicy?.stableAfterMs ?? DEFAULT_RESTART_POLICY.stableAfterMs, 1_000, 86_400_000, "restartPolicy.stableAfterMs"),
  };
  if (restartPolicy.maxBackoffMs < restartPolicy.initialBackoffMs) {
    throw new Error("restartPolicy.maxBackoffMs must be greater than or equal to initialBackoffMs");
  }

  const projects: LoadedFleetProject[] = raw.projects.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`projects[${index}] must be an object`);
    assertAllowedKeys(entry, ["id", "config", "enabled", "pollMs"], `projects[${index}]`);
    const id = boundedId(entry.id, `projects[${index}].id`);
    if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") {
      throw new Error(`projects[${index}].enabled must be boolean`);
    }
    if (typeof entry.config !== "string" || !entry.config.trim()) {
      throw new Error(`projects[${index}].config must not be empty`);
    }
    const configPath = resolve(baseDir, entry.config);
    const config = parseJson<ProjectFileConfig>(configPath, `project ${id} config`);
    if (!config.herdr?.session?.trim() || !config.analyst?.command?.trim()) {
      throw new Error(`project ${id} config requires herdr.session and analyst.command`);
    }
    validateHarnessConfig(config);
    return {
      id,
      configPath,
      configDigest: digest(config),
      enabled: entry.enabled !== false,
      pollMs: boundedInteger(entry.pollMs ?? defaultPollMs, 100, 3_600_000, `projects[${index}].pollMs`),
      config,
    };
  });

  const digestInput = {
    version: 1 as const,
    name,
    stateDir,
    defaultPollMs,
    tickConcurrency,
    tickTimeoutMs,
    shutdownGraceMs,
    maxLogBytes,
    restartPolicy,
    projects: projects.map((project) => ({
      id: project.id,
      configPath: project.configPath,
      configDigest: project.configDigest,
      enabled: project.enabled,
      pollMs: project.pollMs,
      repo: project.config.repo,
      localPath: project.config.localPath,
      stateDir: project.config.stateDir,
      worktreeRoot: project.config.worktreeRoot,
      herdrSession: project.config.herdr.session,
    })),
  };
  const loaded: LoadedFleetConfig = {
    ...digestInput,
    sourcePath,
    projects,
    digest: digest(digestInput),
  };
  validateFleetIsolation(loaded);
  return loaded;
}

export function selectFleetProjects(
  config: LoadedFleetConfig,
  projectId: string | null,
  enabledOnly = true,
): LoadedFleetProject[] {
  const candidates = enabledOnly ? config.projects.filter((project) => project.enabled) : config.projects;
  if (enabledOnly && candidates.length === 0) throw new Error("Fleet has no enabled projects");
  if (projectId === null) return candidates;
  const project = candidates.find((candidate) => candidate.id === projectId);
  if (!project) throw new Error(`Fleet project is ${enabledOnly ? "disabled or " : ""}unknown: ${projectId}`);
  return [project];
}

function assertAllowedKeys(value: object, allowed: string[], label: string): void {
  const permitted = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !permitted.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unsupported keys: ${unknown.join(", ")}`);
}

function parseJson<T>(path: string, label: string): T {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("root must be an object");
    return value as T;
  } catch (error) {
    throw new Error(`${label} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function absoluteOrResolve(value: unknown, baseDir: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`);
  return isAbsolute(value) ? resolve(value) : resolve(baseDir, value);
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function boundedId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    throw new Error(`${label} must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`);
  }
  return value;
}
