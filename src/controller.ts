import { assertJobInvariant } from "./model.js";
import { ControllerContext } from "./controller/context.js";
import { validateHarnessConfig } from "./controller/config-validation.js";
import { prepareAttempt } from "./controller/attempt-preparation.js";
import { driveAttempt } from "./controller/attempt-driver.js";
import { publish, observeMerge } from "./controller/delivery.js";
import { diagnoseOrWait, applyRecovery } from "./controller/recovery-flow.js";
import { selectJob, advanceClaim, archive } from "./controller/task-lifecycle.js";
import type { ControllerDependencies, TickResult } from "./controller/types.js";

export type { ControllerDependencies, TickAction, TickResult } from "./controller/types.js";
export { validateHarnessConfig } from "./controller/config-validation.js";

/**
 * Thin state dispatcher. Domain transitions live in focused controller modules;
 * this facade preserves the public constructor and tick contract.
 */
export class HarnessController {
  private readonly context: ControllerContext;

  constructor(deps: ControllerDependencies) {
    validateHarnessConfig(deps.config);
    if ((deps.config.workerRuntime === "pi-rpc" || deps.config.reviewerRuntime === "pi-rpc") && !deps.piRpc) {
      throw new Error("pi-rpc runtime selection requires the Pi RPC adapter");
    }
    this.context = new ControllerContext(deps);
  }

  async tick(): Promise<TickResult> {
    const state = await this.context.deps.store.load();
    const job = state.activeJob;
    if (!job) return selectJob(this.context, state);
    assertJobInvariant(job);

    switch (job.state) {
      case "claimed": return advanceClaim(this.context, state, job);
      case "worker_ready": return prepareAttempt(this.context, state, job, "worker");
      case "worker_running": return driveAttempt(this.context, state, job, "worker");
      case "reviewer_ready": return prepareAttempt(this.context, state, job, "reviewer");
      case "reviewer_running": return driveAttempt(this.context, state, job, "reviewer");
      case "publish_ready": return publish(this.context, state, job);
      case "awaiting_merge": return observeMerge(this.context, state, job);
      case "blocked": return diagnoseOrWait(this.context, state, job);
      case "recovery_approved": return applyRecovery(this.context, state, job);
      case "done":
      case "cancelled": return archive(this.context, state, job);
    }
    throw new Error(`unsupported Job state: ${String(job.state)}`);
  }
}
