import { resolve } from "node:path";
import { runBoundedProcess } from "./process.js";
import type { FleetTickReport, LoadedFleetConfig, LoadedFleetProject, ProjectTickResult } from "./types.js";

export type ProjectTickRunner = (project: LoadedFleetProject) => Promise<ProjectTickResult>;

export async function runFleetTick(input: {
  config: LoadedFleetConfig;
  projects: LoadedFleetProject[];
  concurrency?: number;
  runner?: ProjectTickRunner;
}): Promise<FleetTickReport> {
  const startedAt = new Date().toISOString();
  const concurrency = Math.max(1, Math.min(input.concurrency ?? input.config.tickConcurrency, input.projects.length || 1));
  const results: ProjectTickResult[] = new Array(input.projects.length);
  let cursor = 0;
  const runner = input.runner ?? ((project) => runProjectTick(input.config, project));
  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= input.projects.length) return;
      const project = input.projects[index]!;
      try {
        results[index] = await runner(project);
      } catch (error) {
        const now = new Date().toISOString();
        results[index] = {
          projectId: project.id,
          ok: false,
          code: null,
          signal: null,
          startedAt: now,
          completedAt: now,
          stdout: "",
          stderr: "",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  });
  await Promise.all(workers);
  return {
    version: 1,
    fleet: input.config.name,
    startedAt,
    completedAt: new Date().toISOString(),
    concurrency,
    ok: results.every((entry) => entry.ok),
    projects: results,
  };
}

async function runProjectTick(config: LoadedFleetConfig, project: LoadedFleetProject): Promise<ProjectTickResult> {
  const cliPath = resolve(import.meta.dirname, "../cli.js");
  const output = await runBoundedProcess({
    command: process.execPath,
    argv: [
      cliPath,
      "tick",
      "--config",
      project.configPath,
      "--expected-config-digest",
      project.configDigest,
    ],
    maxBytes: config.maxLogBytes,
    timeoutMs: config.tickTimeoutMs,
  });
  return {
    projectId: project.id,
    ok: output.code === 0 && output.error === null,
    ...output,
  };
}
