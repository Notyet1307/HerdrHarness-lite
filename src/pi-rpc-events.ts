import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { isQualifiedPiRpcVersion } from "./compatibility.js";

export const MAX_UNKNOWN_PI_RPC_EVENT_BYTES = 64 * 1024;

export type PiRpcEventClassification =
  | "observational"
  | "progress"
  | "authority-changing"
  | "forbidden"
  | "unknown-safe"
  | "unknown-unsafe";

export const PI_RPC_EVENT_CONTRACT = {
  agent_start: "authority-changing",
  agent_end: "authority-changing",
  agent_settled: "progress",
  turn_start: "observational",
  turn_end: "observational",
  message_start: "progress",
  message_update: "progress",
  message_end: "progress",
  tool_execution_start: "progress",
  tool_execution_update: "progress",
  tool_execution_end: "progress",
  bash_execution_update: "progress",
  compaction_start: "authority-changing",
  compaction_end: "authority-changing",
  extension_ui_request: "authority-changing",
  queue_update: "forbidden",
  auto_retry_start: "forbidden",
  auto_retry_end: "forbidden",
  summarization_retry_scheduled: "forbidden",
  summarization_retry_attempt_start: "forbidden",
  summarization_retry_finished: "forbidden",
  extension_ui_response: "forbidden",
} as const satisfies Record<string, Exclude<PiRpcEventClassification, "unknown-safe" | "unknown-unsafe">>;

export type UnknownPiRpcEventReason =
  | "unqualified-version"
  | "invalid-type"
  | "unserializable"
  | "oversize"
  | "control-shape"
  | "credential-content"
  | "text-content";

type JsonObject = Record<string, unknown>;

const UNKNOWN_PROJECTION_KEYS = new Set([
  "type", "classification", "refreshesProgress", "payloadBytes", "payloadDigest", "unsafeReason",
]);
const CONTROL_WORDS = new Set([
  "abort", "ack", "acknowledge", "acknowledgement", "action", "approval", "authority", "await",
  "callback", "cancel", "command", "compaction", "continuation", "controller", "human", "interaction",
  "lifecycle", "model", "permission", "phase", "prompt", "provider", "queue", "replay", "replace",
  "replacement", "reply", "request", "response", "retry", "session", "state", "switch", "tool",
  "transition", "ui",
]);
const CREDENTIAL_WORDS = new Set([
  "auth", "authorization", "bearer", "cookie", "credential", "oauth", "passphrase", "password", "secret",
]);

export function knownPiRpcEventClassification(type: string): PiRpcEventClassification | null {
  return Object.hasOwn(PI_RPC_EVENT_CONTRACT, type)
    ? PI_RPC_EVENT_CONTRACT[type as keyof typeof PI_RPC_EVENT_CONTRACT]
    : null;
}

export function piRpcEventPayloadMetadata(event: JsonObject): { payloadBytes: number; payloadDigest: string } {
  const serialized = JSON.stringify(event);
  if (typeof serialized !== "string") throw new Error("Pi RPC event is not serializable");
  return {
    payloadBytes: Buffer.byteLength(serialized),
    payloadDigest: sha256(serialized),
  };
}

export function projectUnknownPiRpcEvent(event: JsonObject, runtimeVersion: string): JsonObject {
  const reportedType = typeof event.type === "string" ? event.type : "";
  const type = validEventType(reportedType) ? reportedType : "invalid_pi_rpc_event";
  let serialized: string | null = null;
  try {
    const value = JSON.stringify(event);
    if (typeof value === "string") serialized = value;
  } catch {
    // The content-free fallback below still gives the unsafe event a stable digest.
  }
  const payloadBytes = serialized === null ? 0 : Buffer.byteLength(serialized);
  const payloadDigest = sha256(serialized ?? JSON.stringify({ type, unsafeReason: "unserializable" }));
  const unsafeReason = unknownUnsafeReason(event, reportedType, runtimeVersion, serialized, payloadBytes);
  return {
    type,
    classification: unsafeReason === null ? "unknown-safe" : "unknown-unsafe",
    refreshesProgress: false,
    payloadBytes,
    payloadDigest,
    ...(unsafeReason ? { unsafeReason } : {}),
  };
}

export function projectedUnknownPiRpcEventClassification(
  event: JsonObject,
  runtimeVersion: string,
): "unknown-safe" | "unknown-unsafe" {
  const classification = event.classification;
  const safeShape = typeof event.type === "string"
    && validEventType(event.type)
    && knownPiRpcEventClassification(event.type) === null
    && (classification === "unknown-safe" || classification === "unknown-unsafe")
    && event.refreshesProgress === false
    && Number.isSafeInteger(event.payloadBytes)
    && Number(event.payloadBytes) >= 0
    && typeof event.payloadDigest === "string"
    && /^[0-9a-f]{64}$/u.test(event.payloadDigest)
    && Object.keys(event).every((key) => UNKNOWN_PROJECTION_KEYS.has(key));
  if (!safeShape) return "unknown-unsafe";
  if (classification === "unknown-safe") {
    return isQualifiedPiRpcVersion(runtimeVersion)
      && Number(event.payloadBytes) <= MAX_UNKNOWN_PI_RPC_EVENT_BYTES
      && event.unsafeReason === undefined
      ? "unknown-safe"
      : "unknown-unsafe";
  }
  return "unknown-unsafe";
}

function unknownUnsafeReason(
  event: JsonObject,
  type: string,
  runtimeVersion: string,
  serialized: string | null,
  payloadBytes: number,
): UnknownPiRpcEventReason | null {
  if (!isQualifiedPiRpcVersion(runtimeVersion)) return "unqualified-version";
  if (!validEventType(type)) return "invalid-type";
  if (serialized === null || !isJsonValue(event)) return "unserializable";
  if (payloadBytes > MAX_UNKNOWN_PI_RPC_EVENT_BYTES) return "oversize";
  if (hasControlShape(type, event)) return "control-shape";
  if (hasCredentialContent(event)) return "credential-content";
  if (eventPayloadEntries(event).some(([, value]) => typeof value === "string")) return "text-content";
  return null;
}

function hasControlShape(type: string, event: JsonObject): boolean {
  if (controlWords(words(type))) return true;
  return eventPayloadEntries(event).some(([key, value]) => (
    controlWords(words(key))
    || (typeof value === "string" && value.length <= 128 && controlWords(words(value)))
  ));
}

function hasCredentialContent(event: JsonObject): boolean {
  return eventPayloadEntries(event).some(([key]) => {
    const keyWords = words(key);
    const compactKey = keyWords.join("");
    if (keyWords.some((word) => CREDENTIAL_WORDS.has(word))) return true;
    if (compactKey === "apikey" || compactKey.endsWith("accesstoken") || compactKey.endsWith("refreshtoken")) return true;
    if (keyWords.includes("token") && !keyWords.some((word) => [
      "budget", "count", "estimate", "estimated", "input", "output", "total", "usage",
    ].includes(word))) return true;
    return false;
  });
}

function eventPayloadEntries(event: JsonObject): Array<[string, unknown]> {
  return Object.entries(event).flatMap(([key, value]) => (
    key === "type" ? [] : [[key, value] as [string, unknown], ...objectEntries(value)]
  ));
}

function objectEntries(value: unknown): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = [];
  const stack: unknown[] = [value];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const entry of current) {
        entries.push(["", entry]);
        stack.push(entry);
      }
      continue;
    }
    for (const entry of Object.entries(current)) {
      entries.push(entry);
      stack.push(entry[1]);
    }
  }
  return entries;
}

function isJsonValue(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  seen.add(value);
  const valid = (Array.isArray(value) ? value : Object.values(value)).every((entry) => isJsonValue(entry, seen));
  seen.delete(value);
  return valid;
}

function validEventType(type: string): boolean {
  return /^[a-z][a-z0-9_.:-]{0,127}$/u.test(type);
}

function words(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

function controlWords(value: string[]): boolean {
  return value.some((word) => CONTROL_WORDS.has(word))
    || (value.includes("agent") && value.some((word) => ["end", "ended", "settle", "settled", "start", "started"].includes(word)))
    || (value.includes("input") && value.some((word) => ["human", "require", "required", "request", "requested"].includes(word)));
}

function sha256(value: string): string {
  const hash = createHash("sha256");
  hash.update(value);
  return hash.digest("hex");
}
