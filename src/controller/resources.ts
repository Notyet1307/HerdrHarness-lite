import { Buffer } from "node:buffer";
import { resolve } from "node:path";

export const BUNDLED_CODE_REVIEW_SKILL = resolve(import.meta.dirname, "../../../pi/skills/code-review");
export const BUNDLED_FOCUSED_SELF_CHECK_SKILL = resolve(import.meta.dirname, "../../../pi/skills/focused-self-check");
export const BUNDLED_TDD_SKILL = resolve(import.meta.dirname, "../../../pi/skills/tdd");
export const BUNDLED_WORKER_TOOLS_EXTENSION = resolve(import.meta.dirname, "../../../pi/extensions/worker-tools.js");
export const BUNDLED_REVIEW_SUBAGENT_CONFIG_EXTENSION = resolve(import.meta.dirname, "../../../pi/extensions/reviewer-subagent-config.js");
export const BUNDLED_REVIEWER_TOOLS_EXTENSION = resolve(import.meta.dirname, "../../../pi/extensions/reviewer-tools.js");
export const BUNDLED_REVIEW_AXIS_AGENT = resolve(import.meta.dirname, "../../../pi/agents/herdr-harness-review-axis.md");
export const PI_RPC_RUNNER = resolve(import.meta.dirname, "../pi-rpc-runner.js");
export const PI_RPC_SDK_ENTRY = resolve(import.meta.dirname, "../pi-rpc-sdk-entry.js");
export const CREDENTIAL_STARTUP_LAUNCHER = resolve(import.meta.dirname, "../credential-startup.js");

export const WORKER_DESCRIPTOR_ENV = "HERDR_HARNESS_WORKER_DESCRIPTOR";
export const REVIEW_DESCRIPTOR_ENV = "HERDR_HARNESS_REVIEW_DESCRIPTOR";
export const REVIEW_CANONICAL_AGENT_DIR_ENV = "HERDR_HARNESS_REVIEW_CANONICAL_PI_AGENT_DIR";
export const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
export const REVIEW_SUBAGENT_CEILING_ENV = "PI_SUBAGENT_CAPABILITY_CEILING_V1";
export const REVIEW_SUBAGENT_CEILING = Buffer.from(JSON.stringify({
  version: 1,
  allowedTools: ["find", "grep", "ls", "read"],
  allowedAgents: ["herdr-harness-review-axis"],
  denyExtensions: true,
  sources: ["herdr-harness-lite"],
}), "utf8").toString("base64url");
