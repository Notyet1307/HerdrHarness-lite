import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { isSupportedPonytailExtension, SUPPORTED_PI_SUBAGENTS_VERSION } from "../compatibility.js";
import type { HarnessConfig } from "../ports.js";
import { pathsOverlap } from "../path-safety.js";
import { message, validReviewerValidationArgv } from "./helpers.js";
import { runtimeRole } from "./runtime-contract.js";
import {
  BUNDLED_CODE_REVIEW_SKILL,
  BUNDLED_FOCUSED_SELF_CHECK_SKILL,
  BUNDLED_REVIEW_SUBAGENT_CONFIG_EXTENSION,
  BUNDLED_REVIEWER_TOOLS_EXTENSION,
  BUNDLED_TDD_SKILL,
  BUNDLED_WORKER_TOOLS_EXTENSION,
} from "./resources.js";

export function validateHarnessConfig(config: HarnessConfig): void {
  for (const [name, value] of [
    ["repo", config.repo],
    ["localPath", config.localPath],
    ["stateDir", config.stateDir],
    ["baseRef", config.baseRef],
    ["readyLabel", config.readyLabel],
    ["claimLabel", config.claimLabel],
    ["worktreeRoot", config.worktreeRoot],
  ] as const) {
    if (!value.trim()) throw new Error(`${name} must not be empty`);
  }
  for (const [name, path] of [["localPath", config.localPath], ["stateDir", config.stateDir], ["worktreeRoot", config.worktreeRoot]] as const) {
    if (!isAbsolute(path)) throw new Error(`${name} must be absolute`);
  }
  if (pathsOverlap(config.localPath, config.stateDir)) throw new Error("localPath and stateDir must not overlap");
  if (pathsOverlap(config.localPath, config.worktreeRoot)) throw new Error("localPath and worktreeRoot must not overlap");
  if (pathsOverlap(config.stateDir, config.worktreeRoot)) throw new Error("stateDir and worktreeRoot must not overlap");
  if (!Number.isInteger(config.maxReviewRounds) || config.maxReviewRounds < 1) {
    throw new Error("maxReviewRounds must be a positive integer");
  }
  if (!Number.isInteger(config.maxAnalystTurns) || config.maxAnalystTurns < 1 || config.maxAnalystTurns > 5) {
    throw new Error("maxAnalystTurns must be between 1 and 5");
  }
  for (const [name, value] of [
    ["workerArgv", config.workerArgv],
    ["reviewerArgv", config.reviewerArgv],
    ["reviewerValidationArgv", config.reviewerValidationArgv],
  ] as const) {
    if (!Array.isArray(value) || value.some((argument) => typeof argument !== "string")) {
      throw new Error(`${name} must be an array of strings`);
    }
  }
  if (!validReviewerValidationArgv(config.reviewerValidationArgv)) {
    throw new Error("reviewerValidationArgv must contain 1 to 32 non-empty arguments");
  }
  if (config.preflight !== undefined) {
    if (!config.preflight || typeof config.preflight !== "object") {
      throw new Error("preflight must be an object");
    }
    if (config.preflight.piBin !== undefined && !config.preflight.piBin.trim()) {
      throw new Error("preflight.piBin must not be empty");
    }
    if (config.preflight.dockerRequired !== undefined && typeof config.preflight.dockerRequired !== "boolean") {
      throw new Error("preflight.dockerRequired must be boolean");
    }
  }
  const reviewerRole = runtimeRole(config, "reviewer");
  for (const [name, runtime, argv] of [
    ["workerRuntime", config.workerRuntime, config.workerArgv],
    ["reviewerRuntime", config.reviewerRuntime, reviewerRole.argv],
  ] as const) {
    if (runtime !== undefined && runtime !== "herdr-pi-cli" && runtime !== "pi-rpc") {
      throw new Error(`${name} must be herdr-pi-cli or pi-rpc`);
    }
    if (runtime === "pi-rpc" && (
      flagValues(argv, "--provider").length !== 1
      || flagValues(argv, "--model").length !== 1
    )) {
      throw new Error(`${name}=pi-rpc requires one explicit --provider and one exact --model ID`);
    }
  }
  validatePiRoleArgv(
    "workerArgv",
    config.workerArgv,
    ["implement", "tdd", "focused-self-check"],
    ["read", "bash", "edit", "write", "grep", "find", "ls", "worker_submit"],
    ["high", "xhigh", "max"],
  );
  validatePiRoleArgv(
    "reviewerArgv",
    reviewerRole.argv,
    ["code-review"],
    ["read", "grep", "find", "ls", "subagent", "review_preflight", "review_submit"],
    ["max"],
  );
}

function validatePiRoleArgv(
  name: "workerArgv" | "reviewerArgv",
  argv: string[],
  skills: string[],
  tools: string[],
  allowedThinking: readonly ("high" | "xhigh" | "max")[],
): void {
  const fail = (reason: string): never => {
    throw new Error(`${name} must enforce the Pi role contract: ${reason}`);
  };
  validateAllowedPiArgv(argv, fail);
  if (!argv.includes("--no-approve")) fail("--no-approve is required");
  if (!argv.includes("--no-skills")) fail("--no-skills is required");
  for (const flag of ["--no-session", "--no-context-files", "--no-prompt-templates", "--no-themes"]) {
    if (argv.filter((argument) => argument === flag).length !== 1) fail(`exactly one ${flag} is required`);
  }
  if (name === "reviewerArgv") {
    validateReviewerExtensions(argv, fail);
  } else {
    validateWorkerExtension(argv, fail);
  }
  const skillPaths = flagValues(argv, "--skill");
  if (skillPaths.some((path) => !isAbsolute(path))) fail("skill paths must be absolute");
  let loadedSkillIdentities: PiSkillIdentity[] = [];
  try {
    loadedSkillIdentities = skillPaths.map(readPiSkillIdentity);
  } catch (error) {
    fail(`skill metadata cannot be verified: ${message(error)}`);
  }
  const loadedSkills = new Set(loadedSkillIdentities.map((skill) => skill.name));
  if (skills.some((skill) => !loadedSkills.has(skill))) fail(`required skills: ${skills.join(",")}`);
  const reviewSkills = loadedSkillIdentities.filter((skill) => skill.name === "code-review");
  if (skills.includes("code-review")) {
    if (reviewSkills.length !== 1 || reviewSkills[0]!.directory !== BUNDLED_CODE_REVIEW_SKILL) {
      fail("code-review must resolve to the bundled Harness skill");
    }
  } else if (reviewSkills.length > 0) {
    fail("Worker must leave complete code-review to the independent Reviewer");
  }
  const selfCheckSkills = loadedSkillIdentities.filter((skill) => skill.name === "focused-self-check");
  if (skills.includes("focused-self-check") && (
    selfCheckSkills.length !== 1 || selfCheckSkills[0]!.directory !== BUNDLED_FOCUSED_SELF_CHECK_SKILL
  )) {
    fail("focused-self-check must resolve to the bundled Harness skill");
  }
  const tddSkills = loadedSkillIdentities.filter((skill) => skill.name === "tdd");
  if (skills.includes("tdd") && (tddSkills.length !== 1 || tddSkills[0]!.directory !== BUNDLED_TDD_SKILL)) {
    fail("tdd must resolve to the bundled Harness context-closed adapter");
  }
  if (skills.includes("implement")) {
    const matches = loadedSkillIdentities.filter((skill) => skill.name === "implement");
    if (matches.length !== 1 || !hasMattPocockProvenance(matches[0]!)) {
      fail("implement must come from the installed mattpocock/skills package");
    }
  }
  const toolValues = flagValues(argv, "--tools");
  if (toolValues.length !== 1 || !sameSet(toolValues[0]!.split(",").map((tool) => tool.trim()), tools)) {
    fail(`tools must be exactly: ${tools.join(",")}`);
  }
  const thinking = flagValues(argv, "--thinking");
  if (thinking.length !== 1 || !allowedThinking.includes(thinking[0] as "high" | "xhigh" | "max")) {
    fail(`--thinking ${allowedThinking.join(" or ")} is required`);
  }
}

function validateWorkerExtension(argv: string[], fail: (reason: string) => never): void {
  if (argv.filter((argument) => argument === "--no-extensions").length !== 1) {
    fail("exactly one --no-extensions is required");
  }
  const extensions = flagValues(argv, "--extension");
  if (extensions.length < 1 || extensions.length > 2 || extensions.some((path) => !isAbsolute(path))) {
    fail("Worker requires bundled worker-tools and permits only one optional Ponytail extension");
  }
  if (resolve(extensions[0]!) !== BUNDLED_WORKER_TOOLS_EXTENSION) {
    fail("the first Worker extension must be the bundled worker-tools extension");
  }
  if (extensions[1] && !isSupportedPonytailExtension(extensions[1])) {
    fail("the optional second Worker extension must be the declared @dietrichgebert/ponytail Pi extension");
  }
}

function flagValues(argv: string[], flag: string): string[] {
  return argv.flatMap((value, index) => value === flag && argv[index + 1] ? [argv[index + 1]!] : []);
}

function validateAllowedPiArgv(argv: string[], fail: (reason: string) => never): void {
  const valueFlags = new Set(["--skill", "--tools", "--thinking", "--provider", "--model", "--extension"]);
  const booleanFlags = new Set([
    "--no-approve",
    "--no-skills",
    "--no-session",
    "--no-extensions",
    "--no-context-files",
    "--no-prompt-templates",
    "--no-themes",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (booleanFlags.has(argument)) continue;
    if (!valueFlags.has(argument)) fail(`unsupported Pi argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("-")) fail(`${argument} requires a separate value`);
    index += 1;
  }
}

function validateReviewerExtensions(argv: string[], fail: (reason: string) => never): void {
  if (argv.filter((argument) => argument === "--no-extensions").length !== 1) {
    fail("exactly one --no-extensions is required");
  }
  const extensions = flagValues(argv, "--extension");
  if (extensions.length !== 3 || extensions.some((path) => !isAbsolute(path))) {
    fail("exactly three absolute --extension paths are required");
  }
  if (resolve(extensions[0]!) !== BUNDLED_REVIEW_SUBAGENT_CONFIG_EXTENSION) {
    fail("Reviewer subagent config isolation must load first");
  }
  if (!isPiSubagentsExtension(extensions[1]!)) {
    fail("pi-subagents must load after the config isolator");
  }
  if (resolve(extensions[2]!) !== BUNDLED_REVIEWER_TOOLS_EXTENSION) {
    fail("reviewer-tools must load after pi-subagents and restore the Pi agent directory");
  }
}

function isPiSubagentsExtension(path: string): boolean {
  const extensionPath = resolve(path);
  const packageRoot = dirname(extensionPath);
  try {
    const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as {
      name?: unknown; version?: unknown; pi?: { extensions?: unknown }; exports?: Record<string, unknown>;
    };
    const capabilityEntrypoint = manifest.exports?.["./capability-ceiling"];
    return manifest.name === "pi-subagents"
      && manifest.version === SUPPORTED_PI_SUBAGENTS_VERSION
      && existsSync(extensionPath)
      && Array.isArray(manifest.pi?.extensions)
      && manifest.pi.extensions.some((entry) => typeof entry === "string" && resolve(packageRoot, entry) === extensionPath)
      && typeof capabilityEntrypoint === "string"
      && existsSync(resolve(packageRoot, capabilityEntrypoint));
  } catch { return false; }
}

function piSkillDirectory(path: string): string {
  const absolute = resolve(path);
  return basename(absolute) === "SKILL.md" ? dirname(absolute) : absolute;
}

type PiSkillIdentity = { name: string; directory: string };

function readPiSkillIdentity(path: string): PiSkillIdentity {
  const directory = piSkillDirectory(path);
  const frontmatter = readFileSync(resolve(directory, "SKILL.md"), "utf8")
    .match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  const name = frontmatter?.match(/^name:\s*["']?([a-zA-Z0-9._-]+)["']?\s*$/m)?.[1];
  if (!name) throw new Error(`${directory}/SKILL.md has no valid name frontmatter`);
  return { name, directory };
}

function hasMattPocockProvenance(skill: PiSkillIdentity): boolean {
  const installRoot = resolve(skill.directory, "../..");
  if (skill.directory !== resolve(installRoot, "skills", skill.name)) return false;
  try {
    const lock = JSON.parse(readFileSync(resolve(installRoot, ".skill-lock.json"), "utf8")) as {
      version?: unknown; skills?: Record<string, Record<string, unknown>>;
    };
    const entry = lock.skills?.[skill.name];
    return lock.version === 3
      && entry?.source === "mattpocock/skills"
      && entry.sourceType === "github"
      && entry.sourceUrl === "https://github.com/mattpocock/skills.git"
      && entry.skillPath === `skills/engineering/${skill.name}/SKILL.md`
      && entry.pluginName === "mattpocock-skills"
      && typeof entry.skillFolderHash === "string"
      && entry.skillFolderHash.length > 0;
  } catch { return false; }
}

function sameSet(actual: string[], expected: string[]): boolean {
  const values = new Set(actual);
  return values.size === expected.length && expected.every((value) => values.has(value));
}
