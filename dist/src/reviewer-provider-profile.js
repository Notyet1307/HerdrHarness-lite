import { isBoundedText } from "./model.js";
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_PROFILES = 16;
const PROFILE_KEYS = new Set(["credentialMode", "provider", "model"]);
/** Resolve and validate the one Reviewer provider selection bound into an Attempt snapshot. */
export function resolveReviewerProviderProfile(reviewerArgv, configured) {
    if (configured === undefined) {
        return { name: null, credentialMode: "canonical-model-config", argv: [...reviewerArgv] };
    }
    if (!configured || typeof configured !== "object" || Array.isArray(configured)) {
        throw new Error("reviewerProviderProfiles must be an object");
    }
    if (!isBoundedText(configured.active, 64) || !PROFILE_NAME.test(configured.active)) {
        throw new Error("reviewerProviderProfiles.active must be a valid profile name");
    }
    if (!configured.profiles || typeof configured.profiles !== "object" || Array.isArray(configured.profiles)) {
        throw new Error("reviewerProviderProfiles.profiles must be an object");
    }
    const entries = Object.entries(configured.profiles);
    if (entries.length < 1 || entries.length > MAX_PROFILES) {
        throw new Error(`reviewerProviderProfiles must contain 1 to ${MAX_PROFILES} profiles`);
    }
    for (const [name, profile] of entries) {
        if (!PROFILE_NAME.test(name))
            throw new Error(`Reviewer provider profile name is invalid: ${name}`);
        if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
            throw new Error(`Reviewer provider profile ${name} must be an object`);
        }
        const unknownKeys = Object.keys(profile).filter((key) => !PROFILE_KEYS.has(key));
        if (unknownKeys.length > 0)
            throw new Error(`Reviewer provider profile ${name} has unsupported fields`);
        if (profile.credentialMode !== "canonical-oauth" && profile.credentialMode !== "canonical-model-config") {
            throw new Error(`Reviewer provider profile ${name} has an invalid credentialMode`);
        }
        for (const [field, value] of [["provider", profile.provider], ["model", profile.model]]) {
            if (!isBoundedText(value, 200) || value.startsWith("-") || /[\r\n]/.test(value)) {
                throw new Error(`Reviewer provider profile ${name} has an invalid ${field}`);
            }
        }
    }
    const active = configured.profiles[configured.active];
    if (!active)
        throw new Error(`Reviewer provider active profile ${configured.active} is not defined`);
    return {
        name: configured.active,
        credentialMode: active.credentialMode,
        argv: replaceSelectors(reviewerArgv, active.provider, active.model),
    };
}
function replaceSelectors(argv, provider, model) {
    const providerIndexes = flagIndexes(argv, "--provider");
    const modelIndexes = flagIndexes(argv, "--model");
    if (providerIndexes.length !== 1 || modelIndexes.length !== 1) {
        throw new Error("reviewerArgv must contain exactly one --provider and --model when provider profiles are configured");
    }
    const result = [...argv];
    result[providerIndexes[0] + 1] = provider;
    result[modelIndexes[0] + 1] = model;
    return result;
}
function flagIndexes(argv, flag) {
    const indexes = [];
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] === flag)
            indexes.push(index);
    }
    return indexes;
}
//# sourceMappingURL=reviewer-provider-profile.js.map