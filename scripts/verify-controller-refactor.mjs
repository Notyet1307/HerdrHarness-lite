#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import ts from "typescript";

const BASE_COMMIT = "06db50cf261312e7be10cc8ce30808455deb5113";

const movedFlowMethods = {
  selectJob: "src/controller/task-lifecycle.ts",
  advanceClaim: "src/controller/task-lifecycle.ts",
  prepareAttempt: "src/controller/attempt-preparation.ts",
  driveAttempt: "src/controller/attempt-driver.ts",
  finishObservedAttempt: "src/controller/attempt-settlement.ts",
  reconcileAttemptOrBlock: "src/controller/attempt-reconciliation.ts",
  runRuntimePreflight: "src/controller/runtime-preflight.ts",
  verifyExecutionSnapshot: "src/controller/runtime-preflight.ts",
  verifyReviewerIntegrity: "src/controller/attempt-integrity.ts",
  verifyReviewerPreflight: "src/controller/attempt-integrity.ts",
  finishWorker: "src/controller/attempt-settlement.ts",
  finishReviewer: "src/controller/attempt-settlement.ts",
  closeCompletedAttempt: "src/controller/attempt-settlement.ts",
  publish: "src/controller/delivery.ts",
  observeMerge: "src/controller/delivery.ts",
  refreshBaseForReview: "src/controller/delivery.ts",
  diagnoseOrWait: "src/controller/recovery-flow.ts",
  reconcileLateAttemptResult: "src/controller/recovery-flow.ts",
  reconcileBlockedCi: "src/controller/recovery-flow.ts",
  runDiagnosis: "src/controller/recovery-flow.ts",
  applyRecovery: "src/controller/recovery-flow.ts",
  archive: "src/controller/task-lifecycle.ts",
};

const movedContextMethods = {
  block: "src/controller/context.ts",
  saveJob: "src/controller/context.ts",
  runtimeFor: "src/controller/context.ts",
  attemptCwd: "src/controller/context.ts",
  closeAttempt: "src/controller/context.ts",
};

const movedHelpers = {
  rpcEnabled: "src/controller/runtime-contract.ts",
  runtimeRole: "src/controller/runtime-contract.ts",
  snapshotCredentialMode: "src/controller/runtime-contract.ts",
  settleAttempt: "src/controller/helpers.ts",
  dedupeEvidence: "src/controller/helpers.ts",
  isFailedCheck: "src/controller/helpers.ts",
  ciChecksDigest: "src/controller/helpers.ts",
  summarizeCiFailure: "src/controller/helpers.ts",
  validateConfig: { path: "src/controller/config-validation.ts", currentName: "validateHarnessConfig" },
  validatePiRoleArgv: "src/controller/config-validation.ts",
  validateWorkerExtension: "src/controller/config-validation.ts",
  ponytailEnvironment: "src/controller/runtime-contract.ts",
  flagValues: "src/controller/config-validation.ts",
  validateAllowedPiArgv: "src/controller/config-validation.ts",
  validateReviewerExtensions: "src/controller/config-validation.ts",
  isPiSubagentsExtension: "src/controller/config-validation.ts",
  piSkillDirectory: "src/controller/config-validation.ts",
  readPiSkillIdentity: "src/controller/config-validation.ts",
  hasMattPocockProvenance: "src/controller/config-validation.ts",
  sameSet: "src/controller/config-validation.ts",
  result: "src/controller/helpers.ts",
  safeToken: "src/controller/helpers.ts",
  validReviewerValidationArgv: "src/controller/helpers.ts",
  trimSlash: "src/controller/helpers.ts",
  withHerdrDiagnostic: "src/controller/helpers.ts",
  message: "src/controller/helpers.ts",
};

const localBase = process.env.HERDR_BASE_CONTROLLER;
const baseText = localBase ? readFileSync(localBase, "utf8") : (() => {
  const base = spawnSync("git", ["show", `${BASE_COMMIT}:src/controller.ts`], { encoding: "utf8" });
  if (base.status !== 0) throw new Error(`cannot read base Controller: ${base.stderr}`);
  return base.stdout;
})();

const originalMethods = parseClassMethods(baseText, "base-controller.ts", "HarnessController");
const originalHelpers = parseFunctions(baseText, "base-controller.ts");
const functionFiles = new Map();
for (const value of [...Object.values(movedFlowMethods), ...Object.values(movedHelpers)]) {
  const path = typeof value === "string" ? value : value.path;
  if (!functionFiles.has(path)) functionFiles.set(path, parseFunctions(readFileSync(path, "utf8"), path));
}
const contextMethods = parseClassMethods(
  readFileSync("src/controller/context.ts", "utf8"),
  "src/controller/context.ts",
  "ControllerContext",
);

const failures = [];
for (const [name, path] of Object.entries(movedFlowMethods)) {
  compare(name, originalMethods.get(name), functionFiles.get(path)?.get(name), normalizeOldFlow, normalizeNewFlow);
}
for (const name of Object.keys(movedContextMethods)) {
  compare(name, originalMethods.get(name), contextMethods.get(name), compact, compact);
}
for (const [oldName, value] of Object.entries(movedHelpers)) {
  const path = typeof value === "string" ? value : value.path;
  const currentName = typeof value === "string" ? oldName : value.currentName;
  compare(oldName, originalHelpers.get(oldName), functionFiles.get(path)?.get(currentName), compact, normalizeNewHelper);
}

if (failures.length) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  const methodCount = Object.keys(movedFlowMethods).length + Object.keys(movedContextMethods).length;
  process.stdout.write(
    `Verified ${methodCount} Controller methods and ${Object.keys(movedHelpers).length} helpers against ${BASE_COMMIT}.\n`,
  );
}

function compare(name, oldBody, newBody, oldNormalizer, newNormalizer) {
  if (!oldBody || !newBody) {
    failures.push(`${name}: missing old or new body`);
    return;
  }
  if (oldNormalizer(oldBody) !== newNormalizer(newBody)) {
    failures.push(`${name}: body changed outside declared mechanical seams`);
  }
}

function parseClassMethods(text, fileName, className) {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const cls = sf.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === className);
  if (!cls) throw new Error(`${className} not found in ${fileName}`);
  const result = new Map();
  for (const member of cls.members) {
    if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name) && member.body) {
      result.set(member.name.text, member.body.getText(sf));
    }
  }
  return result;
}

function parseFunctions(text, fileName) {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const result = new Map();
  for (const node of sf.statements) {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) result.set(node.name.text, node.body.getText(sf));
  }
  return result;
}

function normalizeOldFlow(value) {
  return compact(value)
    .replace(/!preflight\.ok/g, "preflight.ok===false");
}

function normalizeNewFlow(value) {
  let normalized = value
    .replace(/ctx\.deps/g, "this.deps")
    .replace(/ctx\.block/g, "this.block")
    .replace(/ctx\.saveJob/g, "this.saveJob")
    .replace(/ctx\.runtimeFor/g, "this.runtimeFor")
    .replace(/ctx\.attemptCwd/g, "this.attemptCwd")
    .replace(/ctx\.closeAttempt/g, "this.closeAttempt");
  for (const name of [
    "runRuntimePreflight", "verifyExecutionSnapshot", "verifyReviewerIntegrity", "verifyReviewerPreflight",
    "reconcileAttemptOrBlock", "finishObservedAttempt", "finishWorker", "finishReviewer", "closeCompletedAttempt",
    "refreshBaseForReview", "reconcileLateAttemptResult", "reconcileBlockedCi", "runDiagnosis",
  ]) {
    normalized = normalized.replace(new RegExp(`${name}\\(ctx,\\s*`, "g"), `this.${name}(`);
  }
  return compact(normalized);
}

function normalizeNewHelper(value) {
  return compact(value).replace(
    /if\(pathsOverlap\(config\.localPath,config\.worktreeRoot\)\)thrownewError\("localPathandworktreeRootmustnotoverlap"\);/,
    "",
  );
}

function compact(value) {
  return value.replace(/\s+/g, "");
}
