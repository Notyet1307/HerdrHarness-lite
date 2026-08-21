export const REVIEWER_CONTEXT_BUDGET_BYTES = 256 * 1024;
export const REVIEWER_CONTEXT_BUDGET_RESERVE_BYTES = 4 * 1024;
export const REVIEWER_CONTEXT_BUDGET_EXCEEDED = "reviewer_context_budget_exceeded";

export class ReviewerContextBudgetExceededError extends Error {
  constructor(readonly observedBytes: number) {
    super(`${REVIEWER_CONTEXT_BUDGET_EXCEEDED}: initial Harness context is ${observedBytes} bytes; budget is ${REVIEWER_CONTEXT_BUDGET_BYTES} bytes`);
  }
}

export function assertReviewerInitialContextBudget(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Reviewer initial context byte count is invalid");
  if (bytes > REVIEWER_CONTEXT_BUDGET_BYTES - REVIEWER_CONTEXT_BUDGET_RESERVE_BYTES) {
    throw new ReviewerContextBudgetExceededError(bytes);
  }
}
