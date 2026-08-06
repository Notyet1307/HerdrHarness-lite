import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
export function pathIsWithin(parent, child) {
    const path = relative(canonicalPath(parent), canonicalPath(child));
    return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}
export function pathsOverlap(left, right) {
    return pathIsWithin(left, right) || pathIsWithin(right, left);
}
function canonicalPath(path) {
    let existing = resolve(path);
    const suffix = [];
    while (!existsSync(existing)) {
        const parent = dirname(existing);
        if (parent === existing)
            break;
        suffix.unshift(basename(existing));
        existing = parent;
    }
    return resolve(realpathSync(existing), ...suffix);
}
//# sourceMappingURL=path-safety.js.map