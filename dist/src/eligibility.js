/**
 * Pure GitHub issue-graph selection.
 *
 * Map semantics are intentionally strict: a Map is never claimed, and only its
 * first OPEN child is the frontier. If that child is not executable, later
 * children are not allowed to jump the queue.
 */
export function selectNextTask(snapshots, options) {
    const claimed = options.claimedIssueNumbers ?? new Set();
    const byNumber = new Map(snapshots.map((issue) => [issue.number, issue]));
    const childOwners = new Map();
    for (const issue of snapshots) {
        for (const child of issue.subIssues) {
            const owners = childOwners.get(child.number) ?? [];
            owners.push(issue.number);
            childOwners.set(child.number, owners);
        }
    }
    const diagnostics = [];
    const eligible = [];
    for (const mapIssue of [...snapshots].sort((a, b) => a.number - b.number)) {
        if (mapIssue.subIssues.length === 0)
            continue;
        diagnostics.push({
            issueNumber: mapIssue.number,
            reason: "map_container",
            detail: "Map is a sequencing container and is never claimed",
        });
        const mapFailure = commonFailure(mapIssue, options.readyLabel, claimed);
        if (mapFailure) {
            diagnostics.push({
                issueNumber: mapIssue.number,
                reason: mapFailure.reason,
                detail: `Map is not active: ${mapFailure.detail}`,
            });
            continue;
        }
        if (mapIssue.parentNumber !== null) {
            diagnostics.push({
                issueNumber: mapIssue.number,
                reason: "nested_map",
                detail: `nested Map under #${mapIssue.parentNumber} is unsupported in V1`,
            });
            continue;
        }
        const frontierRef = mapIssue.subIssues.find((child) => child.state === "OPEN");
        if (!frontierRef) {
            diagnostics.push({
                issueNumber: mapIssue.number,
                reason: "map_waiting",
                detail: "Map has no OPEN child",
            });
            continue;
        }
        const frontier = byNumber.get(frontierRef.number);
        if (!frontier) {
            diagnostics.push({
                issueNumber: mapIssue.number,
                reason: "missing_child_snapshot",
                detail: `first OPEN child #${frontierRef.number} was not returned by the GitHub adapter`,
            });
            continue;
        }
        const owners = childOwners.get(frontier.number) ?? [];
        if (owners.length !== 1 || owners[0] !== mapIssue.number || frontier.parentNumber !== mapIssue.number) {
            diagnostics.push({
                issueNumber: frontier.number,
                reason: "ambiguous_parent",
                detail: `frontier parent is inconsistent; owners=${owners.join(",") || "none"}`,
            });
            continue;
        }
        if (frontier.subIssues.length > 0) {
            diagnostics.push({
                issueNumber: frontier.number,
                reason: "nested_map",
                detail: "a Map child cannot itself be a Map in V1",
            });
            continue;
        }
        const failure = commonFailure(frontier, options.readyLabel, claimed);
        if (failure) {
            diagnostics.push({
                issueNumber: frontier.number,
                reason: "map_waiting",
                detail: `strict frontier #${frontier.number} is not executable: ${failure.detail}`,
            });
            continue;
        }
        eligible.push({ issue: frontier, mapNumber: mapIssue.number, selectionKey: mapIssue.number });
    }
    for (const issue of [...snapshots].sort((a, b) => a.number - b.number)) {
        if (issue.subIssues.length > 0 || issue.parentNumber !== null || childOwners.has(issue.number))
            continue;
        const failure = commonFailure(issue, options.readyLabel, claimed);
        if (failure) {
            diagnostics.push({ issueNumber: issue.number, ...failure });
            continue;
        }
        eligible.push({ issue, mapNumber: null, selectionKey: issue.number });
    }
    eligible.sort((a, b) => a.selectionKey - b.selectionKey || a.issue.number - b.issue.number);
    return { selected: eligible[0] ?? null, eligible, diagnostics };
}
export function isStillClaimable(issue, readyLabel) {
    return commonFailure(issue, readyLabel, new Set()) === null;
}
function commonFailure(issue, readyLabel, claimed) {
    if (issue.state !== "OPEN") {
        return { reason: "not_open", detail: `state=${issue.state}` };
    }
    if (!issue.labels.includes(readyLabel)) {
        return { reason: "missing_ready_label", detail: `missing label ${readyLabel}` };
    }
    if (issue.assignees.length > 0) {
        return { reason: "assigned", detail: `assigned to ${issue.assignees.join(", ")}` };
    }
    const openBlockers = issue.blockedBy.filter((blocker) => blocker.state === "OPEN");
    if (openBlockers.length > 0) {
        return {
            reason: "blocked",
            detail: `blocked by ${openBlockers.map((blocker) => `#${blocker.number}`).join(", ")}`,
        };
    }
    if (claimed.has(issue.number)) {
        return { reason: "already_claimed", detail: "issue exists in the durable ledger" };
    }
    return null;
}
//# sourceMappingURL=eligibility.js.map