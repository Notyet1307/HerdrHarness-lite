import test from "node:test";
import assert from "node:assert/strict";
import { resolveReviewerProviderProfile, reviewerAxisConcurrency } from "../src/reviewer-provider-profile.js";

const reviewerArgv = [
  "--provider", "legacy-custom",
  "--model", "legacy-model",
  "--thinking", "max",
];

const profiles = {
  active: "subscription",
  profiles: {
    subscription: {
      credentialMode: "canonical-oauth" as const,
      provider: "openai-codex",
      model: "gpt-5.6-sol",
    },
    custom: {
      credentialMode: "canonical-model-config" as const,
      provider: "baizhi-chat",
      model: "deepseek-v4-flash",
    },
  },
};

test("Reviewer provider profiles switch one immutable argv selection without mutating the base config", () => {
  const selected = resolveReviewerProviderProfile(reviewerArgv, profiles);
  assert.deepEqual(selected, {
    name: "subscription",
    credentialMode: "canonical-oauth",
    argv: [
      "--provider", "openai-codex",
      "--model", "gpt-5.6-sol",
      "--thinking", "max",
    ],
  });
  assert.deepEqual(reviewerArgv.slice(0, 4), ["--provider", "legacy-custom", "--model", "legacy-model"]);

  assert.deepEqual(resolveReviewerProviderProfile(reviewerArgv, { ...profiles, active: "custom" }), {
    name: "custom",
    credentialMode: "canonical-model-config",
    argv: [
      "--provider", "baizhi-chat",
      "--model", "deepseek-v4-flash",
      "--thinking", "max",
    ],
  });
});

test("Reviewer provider profiles preserve legacy custom-provider behavior when omitted", () => {
  assert.deepEqual(resolveReviewerProviderProfile(reviewerArgv), {
    name: null,
    credentialMode: "canonical-model-config",
    argv: reviewerArgv,
  });
});

test("Reviewer axis policy forces openai subscription serial while custom Providers remain configurable", () => {
  assert.equal(reviewerAxisConcurrency({
    credentialMode: "canonical-oauth",
    provider: "openai-codex",
    configured: 2,
  }), 1);
  assert.equal(reviewerAxisConcurrency({
    credentialMode: "canonical-model-config",
    provider: "custom",
    configured: 1,
  }), 1);
  assert.equal(reviewerAxisConcurrency({
    credentialMode: "canonical-model-config",
    provider: "custom",
  }), 2);
});

test("Reviewer provider profiles reject stale, malformed, or unusable switches", () => {
  assert.throws(
    () => resolveReviewerProviderProfile(reviewerArgv, { ...profiles, active: "missing" }),
    /active profile missing is not defined/,
  );
  assert.throws(
    () => resolveReviewerProviderProfile(reviewerArgv, {
      ...profiles,
      profiles: {
        ...profiles.profiles,
        broken: { credentialMode: "runtime-default" as never, provider: "custom", model: "model" },
      },
    }),
    /profile broken has an invalid credentialMode/,
  );
  assert.throws(
    () => resolveReviewerProviderProfile([...reviewerArgv, "--provider", "duplicate"], profiles),
    /reviewerArgv must contain exactly one --provider and --model/,
  );
});
