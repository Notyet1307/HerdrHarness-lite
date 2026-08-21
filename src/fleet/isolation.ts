import { pathsOverlap } from "../path-safety.js";
import type { LoadedFleetConfig, LoadedFleetProject } from "./types.js";

export function validateFleetIsolation(config: LoadedFleetConfig): void {
  rejectDuplicates(config.projects, (project) => project.id.toLowerCase(), "project id");
  rejectDuplicates(config.projects, (project) => project.configPath, "project config path");
  rejectDuplicates(config.projects, (project) => project.config.repo.toLowerCase(), "GitHub repository");
  rejectDuplicates(config.projects, (project) => project.config.herdr.session, "Herdr session");

  for (const project of config.projects) {
    const paths = projectPaths(project);
    for (let left = 0; left < paths.length; left += 1) {
      for (let right = left + 1; right < paths.length; right += 1) {
        assertSeparate(paths[left]!, paths[right]!, `project ${project.id}`);
      }
    }
    for (const path of paths) {
      assertSeparate({ label: "Fleet stateDir", path: config.stateDir }, path, `Fleet/project ${project.id}`);
    }
  }

  for (let left = 0; left < config.projects.length; left += 1) {
    for (let right = left + 1; right < config.projects.length; right += 1) {
      const leftProject = config.projects[left]!;
      const rightProject = config.projects[right]!;
      for (const leftPath of projectPaths(leftProject)) {
        for (const rightPath of projectPaths(rightProject)) {
          assertSeparate(leftPath, rightPath, `projects ${leftProject.id}/${rightProject.id}`);
        }
      }
    }
  }
}

function projectPaths(project: LoadedFleetProject): Array<{ label: string; path: string }> {
  return [
    { label: `${project.id}.localPath`, path: project.config.localPath },
    { label: `${project.id}.stateDir`, path: project.config.stateDir },
    { label: `${project.id}.worktreeRoot`, path: project.config.worktreeRoot },
  ];
}

function assertSeparate(
  left: { label: string; path: string },
  right: { label: string; path: string },
  scope: string,
): void {
  if (pathsOverlap(left.path, right.path)) {
    throw new Error(`${scope} path isolation violation: ${left.label} overlaps ${right.label}`);
  }
}

function rejectDuplicates(
  projects: LoadedFleetProject[],
  key: (project: LoadedFleetProject) => string,
  label: string,
): void {
  const seen = new Map<string, string>();
  for (const project of projects) {
    const value = key(project);
    const previous = seen.get(value);
    if (previous) throw new Error(`duplicate ${label}: projects ${previous} and ${project.id}`);
    seen.set(value, project.id);
  }
}
