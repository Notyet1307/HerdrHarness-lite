import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SUPPORTED_PI_SUBAGENTS_VERSION } from "../src/compatibility.js";

const read = (path: string): string => readFileSync(path, "utf8");

test("generated output and stale context stay out of the repository", () => {
  const trackedDist = spawnSync("git", ["ls-files", "dist"], { encoding: "utf8" });
  assert.equal(trackedDist.status, 0, trackedDist.stderr);
  assert.equal(trackedDist.stdout.trim(), "");
  assert.match(read(".gitignore"), /^dist\/$/m);

  for (const path of ["docs/plans", "docs/research", "docs/archive"]) {
    assert.equal(existsSync(path), false, path);
  }

  const architecture = read("ARCHITECTURE.zh-CN.md");
  for (const forbidden of [
    "建议建立 V2",
    "V1 负责实际领取",
    "阶段四：影子运行",
    "implementation branch",
    "not deployed",
    "run-once.ts",
    "audit-once.ts",
    "push-device",
  ]) {
    assert.equal(architecture.includes(forbidden), false, forbidden);
  }
});

test("Reviewer, compatibility, config, and CLI documentation do not drift", () => {
  const reviewSkill = read("pi/skills/code-review/SKILL.md").toLowerCase();
  for (const forbidden of ["docs/agents/issue-tracker.md", "gh issue", "fetch the issue"]) {
    assert.equal(reviewSkill.includes(forbidden), false, forbidden);
  }

  for (const path of ["README.md", "README.zh-CN.md"]) {
    const content = read(path);
    assert.match(content, new RegExp(`pi install npm:pi-subagents@${SUPPORTED_PI_SUBAGENTS_VERSION.replaceAll(".", "\\.")}`));
    assertReadmeCommandsAreSupported(content, path);
  }

  const config = JSON.parse(read("harness.config.example.json")) as {
    reviewerArgv: string[];
    reviewerProviderProfiles: {
      active: string;
      profiles: Record<string, { provider: string; model: string }>;
    };
  };
  const active = config.reviewerProviderProfiles.profiles[config.reviewerProviderProfiles.active];
  assert.ok(active);
  assert.equal(flagValue(config.reviewerArgv, "--provider"), active.provider);
  assert.equal(flagValue(config.reviewerArgv, "--model"), active.model);
});

test("tracked and new Markdown files have valid local files and anchors", () => {
  const listed = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "--", "*.md"],
    { encoding: "utf8" },
  );
  assert.equal(listed.status, 0, listed.stderr);
  for (const file of listed.stdout.trim().split("\n").filter(Boolean)) {
    for (const target of markdownLinkTargets(read(file))) validateMarkdownTarget(file, target);
  }
});

test("Markdown link validation covers references, HTML targets, and anchors", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-markdown-links-"));
  const source = join(root, "README.md");
  const target = join(root, "guide.md");
  try {
    writeFileSync(source, [
      "[Guide][guide]",
      "[guide]: guide.md#target-heading",
      "<a href=\"guide.md#explicit-anchor\">Guide</a>",
      "<img src=guide.md#target-heading-1>",
    ].join("\n"));
    writeFileSync(target, [
      "# Target heading",
      "# Target heading",
      "<a id=\"explicit-anchor\"></a>",
    ].join("\n"));
    const targets = markdownLinkTargets(read(source));
    assert.deepEqual(targets, [
      "guide.md#target-heading",
      "guide.md#explicit-anchor",
      "guide.md#target-heading-1",
    ]);
    for (const link of targets) validateMarkdownTarget(source, link);
    assert.throws(() => validateMarkdownTarget(source, "guide.md#missing-heading"), /missing-heading/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function assertReadmeCommandsAreSupported(content: string, path: string): void {
  const usage = read("src/cli.ts").match(/const usage = `([\s\S]*?)`;/)?.[1] ?? "";
  const supported = new Set([...usage.matchAll(/herdr-harness-lite ([a-z-]+)/g)].map((match) => match[1]!));
  const documented = [...content.matchAll(/(?:node dist\/src\/cli\.js|herdr-harness-lite) ([a-z][a-z-]*)/g)]
    .map((match) => match[1]!);
  for (const command of documented) assert.equal(supported.has(command), true, `${path}: ${command}`);
  for (const command of ["tick", "run", "status", "decide"]) {
    assert.equal(documented.includes(command), true, `${path}: missing ${command}`);
  }
}

function flagValue(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] ?? null : null;
}

function markdownLinkTargets(content: string): string[] {
  const definitions = new Map<string, string>();
  for (const match of content.matchAll(/^\s*\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))/gm)) {
    definitions.set(referenceLabel(match[1]!), match[2] ?? match[3]!);
  }
  const targets = [...content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1]!);
  for (const match of content.matchAll(/\[([^\]\n]+)\]\[([^\]\n]*)\]/g)) {
    const label = referenceLabel(match[2] || match[1]!);
    const target = definitions.get(label);
    if (!target) throw new Error(`undefined Markdown reference: ${label}`);
    targets.push(target);
  }
  targets.push(...[...content.matchAll(/<(?:a|img)\b[^>]*\b(?:href|src)=(?:["']([^"']+)["']|([^\s>]+))[^>]*>/gi)]
    .map((match) => match[1] ?? match[2]!));
  return targets;
}

function validateMarkdownTarget(file: string, rawTarget: string): void {
  const target = rawTarget.trim().replace(/^<|>$/g, "");
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) return;
  const hash = target.indexOf("#");
  const rawPath = (hash < 0 ? target : target.slice(0, hash)).split("?", 1)[0]!;
  const fragment = hash < 0 ? "" : decodeURIComponent(target.slice(hash + 1)).toLowerCase();
  const targetPath = rawPath ? resolve(dirname(file), decodeURIComponent(rawPath)) : resolve(file);
  assert.equal(existsSync(targetPath), true, `${file} -> ${target}`);
  if (!fragment || !targetPath.toLowerCase().endsWith(".md")) return;
  assert.equal(lstatSync(targetPath).isFile(), true, `${file} -> ${target}`);
  assert.equal(markdownAnchors(read(targetPath)).has(fragment), true, `${file} -> #${fragment}`);
}

function markdownAnchors(content: string): Set<string> {
  const anchors = new Set<string>();
  const duplicates = new Map<string, number>();
  for (const match of content.matchAll(/^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)) {
    const base = match[1]!
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/[`*_~]/g, "")
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s+/g, "-");
    const duplicate = duplicates.get(base) ?? 0;
    anchors.add(duplicate === 0 ? base : `${base}-${duplicate}`);
    duplicates.set(base, duplicate + 1);
  }
  for (const match of content.matchAll(/<(?:a|h[1-6])\b[^>]*(?:id|name)=["']([^"']+)["']/gi)) {
    anchors.add(match[1]!.toLowerCase());
  }
  return anchors;
}

function referenceLabel(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}
