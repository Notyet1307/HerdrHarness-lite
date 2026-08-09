import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireControllerLease, controllerLeasePath } from "../src/controller-lease.js";
test("Controller lease excludes a second run or tick and releases only its own lease", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-lite-controller-lease-"));
    try {
        const first = acquireControllerLease(root);
        assert.throws(() => acquireControllerLease(root), new RegExp(`Controller lease is held by pid ${process.pid}`));
        first.stop();
        const second = acquireControllerLease(root);
        assert.ok(controllerLeasePath(root).endsWith("controller-lease.json"));
        second.stop();
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
//# sourceMappingURL=controller-lease.test.js.map