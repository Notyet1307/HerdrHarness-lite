import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
const DEFAULT_INTERVAL_MS = 10_000;
export function controllerHeartbeatPath(stateDir) {
    if (!isAbsolute(stateDir))
        throw new Error("heartbeat stateDir must be absolute");
    return join(stateDir, "controller-heartbeat.json");
}
export function startControllerHeartbeat(stateDir, intervalMs = DEFAULT_INTERVAL_MS) {
    const path = controllerHeartbeatPath(stateDir);
    writeHeartbeat(path, process.pid);
    const child = spawn(process.execPath, [
        resolve(import.meta.dirname, "controller-heartbeat.js"),
        "pulse",
        path,
        String(process.pid),
        String(intervalMs),
    ], { stdio: "ignore" });
    if (!child.pid)
        throw new Error("Controller heartbeat process did not start");
    child.unref();
    return { stop: () => { child.kill("SIGTERM"); } };
}
function writeHeartbeat(path, parentPid) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ version: 1, parentPid, updatedAt: new Date().toISOString() })}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
}
function pulse(path, parentPid, intervalMs) {
    if (!isAbsolute(path) || !Number.isInteger(parentPid) || parentPid < 1 || !Number.isInteger(intervalMs) || intervalMs < 10) {
        throw new Error("invalid Controller heartbeat arguments");
    }
    while (process.ppid === parentPid) {
        writeHeartbeat(path, parentPid);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, intervalMs);
    }
}
if (process.argv[2] === "pulse") {
    try {
        pulse(process.argv[3] ?? "", Number(process.argv[4]), Number(process.argv[5]));
    }
    catch (error) {
        process.stderr.write(`FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
//# sourceMappingURL=controller-heartbeat.js.map