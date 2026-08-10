import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const DESCRIPTOR_ENV = "HERDR_HARNESS_REVIEW_DESCRIPTOR";
export const ORIGINAL_AGENT_DIR_ENV = "HERDR_HARNESS_REVIEW_ORIGINAL_PI_AGENT_DIR";
export const CANONICAL_AGENT_DIR_ENV = "HERDR_HARNESS_REVIEW_CANONICAL_PI_AGENT_DIR";
export const PI_PACKAGE_ROOT_ENV = "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT";

export default function reviewerSubagentConfig() {
  const descriptorPath = process.env[DESCRIPTOR_ENV];
  const runtimeAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalAgentDir = process.env[CANONICAL_AGENT_DIR_ENV] ?? runtimeAgentDir;
  if (!descriptorPath || !isAbsolute(descriptorPath) || !runtimeAgentDir || !isAbsolute(runtimeAgentDir)
    || !originalAgentDir || !isAbsolute(originalAgentDir)) {
    throw new Error("Reviewer subagent config isolation requires absolute descriptor and Pi agent directories");
  }
  if (process.env[ORIGINAL_AGENT_DIR_ENV]) throw new Error("Reviewer subagent config isolation was already applied");
  const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
  if (resolve(originalAgentDir) !== descriptor.piAgentDir) {
    throw new Error("Reviewer canonical Pi agent directory differs from the Attempt descriptor");
  }
  const configPath = realpathSync(descriptor.subagentConfigPath ?? "");
  const configDir = realpathSync(descriptor.subagentConfigDir ?? "");
  const content = readFileSync(configPath, "utf8");
  if (
    !existsSync(configDir)
    || !/^[0-9a-f]{64}$/i.test(descriptor.subagentConfigDigest ?? "")
    || sha256(content) !== descriptor.subagentConfigDigest
    || (lstatSync(configPath).mode & 0o222)
  ) {
    throw new Error("Reviewer subagent config snapshot is missing, writable, or changed");
  }
  const runtimePath = realpathSync(descriptor.runtimePath ?? "");
  const wrapperPath = realpathSync(descriptor.piSubagentWrapperPath ?? "");
  const emptyAppendPath = realpathSync(descriptor.emptyAppendSystemPromptPath ?? "");
  if (
    !pathWithin(runtimePath, wrapperPath)
    || !pathWithin(runtimePath, emptyAppendPath)
    || !immutableDigest(wrapperPath, descriptor.piSubagentWrapperDigest)
    || !(lstatSync(wrapperPath).mode & 0o111)
    || !immutableDigest(emptyAppendPath, descriptor.emptyAppendSystemPromptDigest)
  ) {
    throw new Error("Reviewer child Pi wrapper or append-system prompt override changed");
  }
  accessSync(wrapperPath, constants.X_OK);
  process.env[ORIGINAL_AGENT_DIR_ENV] = originalAgentDir;
  delete process.env[CANONICAL_AGENT_DIR_ENV];
  delete process.env[PI_PACKAGE_ROOT_ENV];
  process.env.PI_CODING_AGENT_DIR = configDir;
  process.env.PI_SUBAGENT_PI_BINARY = wrapperPath;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function immutableDigest(path, expected) {
  return /^[0-9a-f]{64}$/i.test(expected ?? "")
    && !(lstatSync(path).mode & 0o222)
    && sha256(readFileSync(path)) === expected;
}

function pathWithin(root, target) {
  const value = relative(root, target);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}
