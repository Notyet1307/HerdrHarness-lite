import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SESSION_ID = "019fc279-5388-7a62-b91f-1a8990102301";
const OTHER_SESSION_ID = "019fc279-5388-7a62-b91f-1a8990102302";

test("Codex Analyst start binds one real session to one job and task digest", () => {
  const fixture = createFixture();
  try {
    const request = startRequest("a".repeat(64));
    const first = callWrapper(fixture, request);
    const repeated = callWrapper(fixture, request);

    assert.equal(first.status, 0, first.stderr);
    assert.equal(repeated.status, 0, repeated.stderr);
    const started = JSON.parse(first.stdout) as { sessionId: string; agentName: string; startedAt: string };
    assert.equal(started.sessionId, SESSION_ID);
    assert.equal(started.agentName, "codex-analyst-job-1");
    assert.ok(Number.isFinite(Date.parse(started.startedAt)));
    assert.equal(repeated.stdout, first.stdout);
    assert.equal(readFileSync(fixture.callsPath, "utf8").trim().split("\n").length, 1);

    const payloadDrift = startRequest("a".repeat(64)) as { task: { title: string } };
    payloadDrift.task.title = "Changed without changing the caller digest";
    const driftedPayload = callWrapper(fixture, payloadDrift);
    assert.equal(driftedPayload.status, 1);
    assert.match(driftedPayload.stderr, /different task payload/);

    const mismatched = callWrapper(fixture, startRequest("b".repeat(64)));
    assert.equal(mismatched.status, 1);
    assert.match(mismatched.stderr, /different task digest/);
    assert.equal(readFileSync(fixture.callsPath, "utf8").trim().split("\n").length, 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("an interrupted Analyst start reservation never launches a replacement session", () => {
  const fixture = createCrashingFixture();
  try {
    const interrupted = callWrapper(fixture, startRequest("a".repeat(64)));
    assert.equal(interrupted.status, null);

    const retried = callWrapper(fixture, startRequest("a".repeat(64)));
    assert.equal(retried.status, 1);
    assert.match(retried.stderr, /starting; refusing a replacement session/);
    assert.equal(readFileSync(fixture.callsPath, "utf8").trim(), "start");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("an Analyst command error with NUL still leaves a readable fail-closed receipt", () => {
  const fixture = createFixture("nul-start-error");
  try {
    const request = startRequest("a".repeat(64));
    const failed = callWrapper(fixture, request);
    assert.equal(failed.status, 1);

    const retried = callWrapper(fixture, request);
    assert.equal(retried.status, 1);
    assert.match(retried.stderr, /unavailable; refusing a replacement session/);
    assert.equal(readFileSync(fixture.callsPath, "utf8").trim().split("\n").length, 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Codex Analyst start rejects JSONL containing a second session identity", () => {
  const fixture = createFixture("duplicate-start-session");
  try {
    const result = callWrapper(fixture, startRequest("a".repeat(64)));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /malformed startup JSONL/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Codex Analyst turn is replay-safe and bound to the evidence digest", () => {
  const fixture = createFixture();
  try {
    const started = callWrapper(fixture, startRequest("a".repeat(64)));
    assert.equal(started.status, 0, started.stderr);
    const session = JSON.parse(started.stdout) as { sessionId: string; agentName: string; startedAt: string };
    const request = turnRequest(session, "c".repeat(64));

    const first = callWrapper(fixture, request);
    const repeated = callWrapper(fixture, request);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.deepEqual(JSON.parse(first.stdout), {
      kind: "advice",
      action: "hold",
      summary: "Wait for bounded evidence.",
      resolutionBrief: "",
      evidenceRefs: ["task"],
      unknowns: ["test output is missing"],
    });
    assert.equal(repeated.stdout, first.stdout);

    const drifted = callWrapper(fixture, turnRequest(session, "d".repeat(64)));
    assert.equal(drifted.status, 1);
    assert.match(drifted.stderr, /different evidence digest/);

    const contentDrifted = turnRequest(session, "c".repeat(64)) as {
      evidence: { items: Array<{ summary: string }> };
    };
    contentDrifted.evidence.items[0]!.summary = "changed without changing the caller digest";
    const contentDrift = callWrapper(fixture, contentDrifted);
    assert.equal(contentDrift.status, 1);
    assert.match(contentDrift.stderr, /different request payload/);

    const calls = readFileSync(fixture.callsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.equal(calls.length, 2);
    assert.ok(calls[1]!.includes("resume"));
    assert.ok(calls[1]!.includes(SESSION_ID));
    assert.match(calls[1]!.at(-1)!, /primarily in concise Simplified Chinese/);
    assert.match(calls[1]!.at(-1)!, /summary must be an outcome-first conclusion/);
    assert.match(calls[1]!.at(-1)!, /recommended next step and why it is the safest allowed action/);
    for (const args of calls) {
      assert.ok(args.includes("--strict-config"));
      assert.ok(args.includes("--ignore-user-config"));
      assert.ok(args.includes("--ignore-rules"));
      assert.ok(args.includes('approval_policy="never"'));
      assert.ok(args.includes('sandbox_mode="read-only"'));
      assert.ok(args.includes('web_search="disabled"'));
      assert.ok(args.includes("shell_tool"));
      assert.ok(args.includes("--json"));
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Codex Analyst turn rejects JSONL from a different session", () => {
  const fixture = createFixture("wrong-resume-session");
  try {
    const startedResult = callWrapper(fixture, startRequest("a".repeat(64)));
    assert.equal(startedResult.status, 0, startedResult.stderr);
    const started = JSON.parse(startedResult.stdout) as { sessionId: string; agentName: string; startedAt: string };

    const result = callWrapper(fixture, turnRequest(started, "c".repeat(64)));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /different session/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("an interrupted Analyst turn reservation never resumes the session twice", () => {
  const fixture = createFixture("crash-resume");
  try {
    const startedResult = callWrapper(fixture, startRequest("a".repeat(64)));
    assert.equal(startedResult.status, 0, startedResult.stderr);
    const started = JSON.parse(startedResult.stdout) as { sessionId: string; agentName: string; startedAt: string };
    const request = turnRequest(started, "c".repeat(64));

    const interrupted = callWrapper(fixture, request);
    assert.equal(interrupted.status, null);

    const retried = callWrapper(fixture, request);
    assert.equal(retried.status, 1);
    assert.match(retried.stderr, /pending; refusing to replay it/);
    assert.equal(readFileSync(fixture.callsPath, "utf8").trim().split("\n").length, 2);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Codex Analyst close deletes only the exact recorded session and is idempotent", () => {
  const fixture = createFixture();
  try {
    const startedResult = callWrapper(fixture, startRequest("a".repeat(64)));
    assert.equal(startedResult.status, 0, startedResult.stderr);
    const started = JSON.parse(startedResult.stdout) as { sessionId: string; agentName: string; startedAt: string };
    const request = closeRequest(started);

    const mismatched = callWrapper(fixture, {
      ...(request as Record<string, unknown>),
      taskDigest: "b".repeat(64),
      session: { ...started, id: started.sessionId, taskDigest: "b".repeat(64) },
    });
    assert.equal(mismatched.status, 1);
    assert.match(mismatched.stderr, /different job or task/);

    const first = callWrapper(fixture, request);
    const repeated = callWrapper(fixture, request);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.deepEqual(JSON.parse(first.stdout), { status: "closed", sessionId: SESSION_ID });
    assert.equal(repeated.stdout, first.stdout);

    const calls = readFileSync(fixture.callsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], ["delete", "--force", SESSION_ID]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function createFixture(
  mode: "normal" | "crash-resume" | "nul-start-error" | "duplicate-start-session" | "wrong-resume-session" = "normal",
): { root: string; stateDir: string; codexBin: string; callsPath: string } {
  const root = join("/tmp", `herdr-lite-analyst-${randomUUID()}`);
  const stateDir = join(root, "state");
  const codexBin = join(root, "fake-codex.mjs");
  const callsPath = join(root, "calls.log");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    codexBin,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");
if (args[0] === "delete") {
  process.exitCode = 0;
} else if (args[1] === "resume") {
  if (${JSON.stringify(mode === "crash-resume")}) process.kill(process.ppid, "SIGKILL");
  process.stdout.write(${JSON.stringify(`${JSON.stringify({ type: "thread.started", thread_id: mode === "wrong-resume-session" ? OTHER_SESSION_ID : SESSION_ID })}\n`)});
  process.stdout.write(${JSON.stringify(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ kind: "advice", action: "hold", summary: "Wait for bounded evidence.", resolutionBrief: "", evidenceRefs: ["task"], unknowns: ["test output is missing"] }) } })}\n`)});
} else {
  if (${JSON.stringify(mode === "nul-start-error")}) {
    process.stderr.write(${JSON.stringify("failed\u0000start")});
    process.exit(1);
  }
  process.stdout.write(${JSON.stringify(`${JSON.stringify({ type: "thread.started", thread_id: SESSION_ID })}\n`)});
  if (${JSON.stringify(mode === "duplicate-start-session")}) {
    process.stdout.write(${JSON.stringify(`${JSON.stringify({ type: "thread.started", thread_id: OTHER_SESSION_ID })}\n`)});
  }
  process.stdout.write(${JSON.stringify(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: '{"status":"ready"}' } })}\n`)});
}
`,
    { encoding: "utf8", mode: 0o700 },
  );
  chmodSync(codexBin, 0o700);
  return { root, stateDir, codexBin, callsPath };
}

function createCrashingFixture(): { root: string; stateDir: string; codexBin: string; callsPath: string } {
  const root = join("/tmp", `herdr-lite-analyst-crash-${randomUUID()}`);
  const stateDir = join(root, "state");
  const codexBin = join(root, "crashing-codex.mjs");
  const callsPath = join(root, "calls.log");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    codexBin,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(callsPath)}, "start\\n");
process.kill(process.ppid, "SIGKILL");
`,
    { encoding: "utf8", mode: 0o700 },
  );
  chmodSync(codexBin, 0o700);
  return { root, stateDir, codexBin, callsPath };
}

function callWrapper(
  fixture: { stateDir: string; codexBin: string },
  request: unknown,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.argv[0]!,
    ["dist/src/codex-analyst-wrapper.js", "--state-dir", fixture.stateDir, "--codex-bin", fixture.codexBin],
    { encoding: "utf8", input: `${JSON.stringify(request)}\n`, timeout: 5_000 },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function startRequest(taskDigest: string): unknown {
  return {
    operation: "start",
    jobId: "job-1",
    task: {
      repo: "owner/repo",
      issueNumber: 1,
      mapNumber: null,
      title: "Test task",
      objective: "Keep the wrapper task-bound.",
      labels: ["agent:claimed"],
      issueUpdatedAt: "2026-08-04T00:00:00.000Z",
      digest: taskDigest,
    },
  };
}

function turnRequest(
  started: { sessionId: string; agentName: string; startedAt: string },
  evidenceDigest: string,
): unknown {
  const taskDigest = "a".repeat(64);
  return {
    operation: "turn",
    session: {
      id: started.sessionId,
      agentName: started.agentName,
      startedAt: started.startedAt,
      taskDigest,
    },
    job: {
      id: "job-1",
      revision: 7,
      state: "blocked",
      task: { ...((startRequest(taskDigest) as { task: Record<string, unknown> }).task) },
      incident: { id: "incident-1", class: "agent_blocked", allowedActions: ["retry_fresh_worker", "hold"] },
    },
    evidence: {
      incidentId: "incident-1",
      jobId: "job-1",
      jobRevision: 7,
      taskDigest,
      digest: evidenceDigest,
      items: [{ ref: "task", source: "ledger.task", summary: "bounded task", digest: "e".repeat(64), trust: "untrusted" }],
      missing: ["test_output"],
    },
    turn: 1,
    allowedOutput: {
      need_evidence: ["issue_context", "git_status", "git_diff", "test_output", "attempt_result", "file_excerpt"],
      advice: ["retry_fresh_worker", "retry_fresh_reviewer", "hold"],
    },
  };
}

function closeRequest(started: { sessionId: string; agentName: string; startedAt: string }): unknown {
  return {
    operation: "close",
    jobId: "job-1",
    taskDigest: "a".repeat(64),
    session: {
      id: started.sessionId,
      agentName: started.agentName,
      startedAt: started.startedAt,
      taskDigest: "a".repeat(64),
    },
  };
}
