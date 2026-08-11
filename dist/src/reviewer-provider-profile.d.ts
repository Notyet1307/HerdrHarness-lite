import type { PiRpcCredentialMode, ReviewerProviderProfiles } from "./ports.js";
export type ReviewerProviderSelection = {
    name: string | null;
    credentialMode: PiRpcCredentialMode;
    argv: string[];
};
/** Resolve and validate the one Reviewer provider selection bound into an Attempt snapshot. */
export declare function resolveReviewerProviderProfile(reviewerArgv: readonly string[], configured?: ReviewerProviderProfiles): ReviewerProviderSelection;
