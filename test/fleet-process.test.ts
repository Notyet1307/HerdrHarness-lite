import test from "node:test";
import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { appendTail, runBoundedProcess } from "../src/fleet/process.js";

test("bounded process terminates a stuck project tick", async () => {
  const output = await runBoundedProcess({
    command: process.execPath,
    argv: ["-e", "setTimeout(() => {}, 10000)"],
    maxBytes: 4_096,
    timeoutMs: 25,
  });
  assert.match(output.error ?? "", /timed out after 25ms/);
});


test("bounded output tail never exceeds its UTF-8 byte budget", () => {
  const tail = appendTail("prefix", "🙂🙂🙂", 8);
  assert.equal(Buffer.byteLength(tail, "utf8") <= 8, true);
  assert.equal(tail, "🙂🙂");
});
