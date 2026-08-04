import test from "node:test";
import assert from "node:assert/strict";
import { selectNextTask } from "../src/eligibility.js";
import { issue } from "./fakes.js";

test("strict Map frontier does not jump over a blocked first OPEN child", () => {
  const graph = [
    issue({
      number: 10,
      title: "Map",
      subIssues: [
        { number: 11, state: "OPEN" },
        { number: 12, state: "OPEN" },
      ],
    }),
    issue({
      number: 11,
      title: "first child",
      parentNumber: 10,
      blockedBy: [{ number: 99, state: "OPEN" }],
    }),
    issue({ number: 12, title: "later child", parentNumber: 10 }),
    issue({ number: 20, title: "standalone" }),
  ];

  const result = selectNextTask(graph, { readyLabel: "ready-for-agent" });
  assert.equal(result.selected?.issue.number, 20);
  assert.ok(result.diagnostics.some((entry) => entry.issueNumber === 11 && entry.reason === "map_waiting"));
});

test("Map container is never claimed and its first executable OPEN child is selected", () => {
  const graph = [
    issue({
      number: 5,
      title: "Map",
      subIssues: [
        { number: 6, state: "CLOSED" },
        { number: 7, state: "OPEN" },
        { number: 8, state: "OPEN" },
      ],
    }),
    issue({ number: 6, title: "done", state: "CLOSED", parentNumber: 5 }),
    issue({ number: 7, title: "frontier", parentNumber: 5 }),
    issue({ number: 8, title: "later", parentNumber: 5 }),
  ];

  const result = selectNextTask(graph, { readyLabel: "ready-for-agent" });
  assert.equal(result.selected?.issue.number, 7);
  assert.equal(result.selected?.mapNumber, 5);
  assert.ok(!result.eligible.some((entry) => entry.issue.number === 5));
  assert.ok(!result.eligible.some((entry) => entry.issue.number === 8));
});

test("only OPEN ready unassigned issues without OPEN blockers are eligible", () => {
  const graph = [
    issue({ number: 1, title: "closed", state: "CLOSED" }),
    issue({ number: 2, title: "no label", labels: [] }),
    issue({ number: 3, title: "assigned", assignees: ["someone"] }),
    issue({ number: 4, title: "blocked", blockedBy: [{ number: 30, state: "OPEN" }] }),
    issue({ number: 5, title: "closed blocker ignored", blockedBy: [{ number: 31, state: "CLOSED" }] }),
  ];

  const result = selectNextTask(graph, { readyLabel: "ready-for-agent" });
  assert.equal(result.selected?.issue.number, 5);
  assert.deepEqual(result.eligible.map((entry) => entry.issue.number), [5]);
});

test("durably claimed issues are not selected again", () => {
  const graph = [issue({ number: 1, title: "first" }), issue({ number: 2, title: "second" })];
  const result = selectNextTask(graph, {
    readyLabel: "ready-for-agent",
    claimedIssueNumbers: new Set([1]),
  });
  assert.equal(result.selected?.issue.number, 2);
});
