import { acquireFleetLease } from "./lease.js";
import { FleetStateStore } from "./store.js";
import type { LoadedFleetConfig } from "./types.js";

export function resetFleetProject(config: LoadedFleetConfig, projectId: string): Record<string, unknown> {
  const configuredProject = config.projects.find((project) => project.id === projectId);
  if (!configuredProject) throw new Error(`unknown Fleet project: ${projectId}`);
  const lease = acquireFleetLease(config.stateDir);
  try {
    const store = new FleetStateStore(config.stateDir);
    const state = store.load();
    if (!state) throw new Error("Fleet runtime state does not exist");
    const project = state.projects[projectId];
    if (!project) throw new Error(`Fleet runtime state has no project ${projectId}`);
    if (project.configDigest !== configuredProject.configDigest) {
      throw new Error(`Fleet runtime state belongs to a different config for project ${projectId}`);
    }
    project.phase = "stopped";
    project.pid = null;
    project.owned = false;
    project.nextStartAt = null;
    project.restartTimestamps = [];
    project.lastError = null;
    state.updatedAt = new Date().toISOString();
    state.stopping = false;
    store.save(state, { type: "project_circuit_reset", projectId });
    return { projectId, phase: project.phase, restartTimestamps: project.restartTimestamps };
  } finally {
    lease.stop();
  }
}
