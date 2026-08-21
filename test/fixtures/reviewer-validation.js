#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const number = (name, fallback = 0) => {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? fallback : Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
};

writeFileSync("validation-only.txt", "ok");
writeFileSync("validation-env.json", JSON.stringify(process.env));
process.stdout.write("v".repeat(number("--stdout-bytes")));
process.stderr.write("e".repeat(number("--stderr-bytes")));
process.exitCode = number("--exit-code");
