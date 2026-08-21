#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const number = (name, fallback = 0) => {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? fallback : Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
};

const output = (stream, bytes, head, tail, fill) => {
  const fixed = `${head}\n${tail}`;
  const value = bytes <= Buffer.byteLength(fixed)
    ? fixed.slice(0, bytes)
    : `${head}\n${fill.repeat(bytes - Buffer.byteLength(fixed))}${tail}`;
  stream.write(value);
};

if (process.argv.includes("--ignore-sigterm")) {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
}

writeFileSync("validation-only.txt", "ok");
writeFileSync("validation-env.json", JSON.stringify(process.env));
const orphanIndex = process.argv.indexOf("--spawn-orphan-pid-path");
if (orphanIndex >= 0) {
  const orphan = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  writeFileSync(process.argv[orphanIndex + 1], String(orphan.pid));
  orphan.unref();
}
await new Promise((resolve) => setTimeout(resolve, number("--sleep-ms")));
output(process.stdout, number("--stdout-bytes"), "stdout-head", "stdout-tail", "v");
output(process.stderr, number("--stderr-bytes"), "stderr-head", "stderr-tail", "e");
process.exitCode = number("--exit-code");
