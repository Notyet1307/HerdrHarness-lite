import type {
  AnalystPort,
  AttemptRuntimePort,
  Clock,
  EvidencePort,
  GitHubPort,
  GitPort,
  HarnessConfig,
  HerdrPort,
  IdGenerator,
  RuntimePreflightPort,
  StateStore,
} from "../ports.js";

export type TickAction =
  | "idle"
  | "preflight_failed"
  | "selected"
  | "claimed"
  | "worktree_created"
  | "attempt_prepared"
  | "attempt_pane_ready"
  | "attempt_agent_ready"
  | "attempt_dispatched"
  | "attempt_reconciling"
  | "attempt_completed"
  | "analysis_recorded"
  | "auto_recovery_authorized"
  | "waiting_for_approval"
  | "recovery_applied"
  | "ci_recovered"
  | "base_refreshed"
  | "published"
  | "publish_retry"
  | "waiting_for_merge"
  | "merged"
  | "archived"
  | "blocked";

export type TickResult = {
  ok: boolean;
  action: TickAction;
  jobId: string | null;
  message: string;
};

export type ControllerDependencies = {
  config: HarnessConfig;
  store: StateStore;
  github: GitHubPort;
  git: GitPort;
  herdr: HerdrPort;
  analyst: AnalystPort;
  evidence: EvidencePort;
  clock: Clock;
  ids: IdGenerator;
  preflight: RuntimePreflightPort;
  piRpc?: AttemptRuntimePort;
};
