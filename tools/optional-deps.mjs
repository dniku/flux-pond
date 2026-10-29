/*
 * Locate the optional test dependencies, wherever this checkout happens to live.
 *
 * Two worlds resolve them, in this order:
 *
 *  1. Normal Node resolution -- the project's own `node_modules`, or the
 *     `NODE_PATH` the nix dev shell sets (`nix develop` puts jsdom, pngjs and
 *     esbuild there, at the versions package-lock.json pins).
 *  2. A shared `node_modules` elsewhere on this host, searched absolutely
 *     because ESM ignores NODE_PATH. This exists because the container this
 *     project grew up in has no network and no way to install anything; it is a
 *     fallback, and deliberately second, so a shell that *does* declare its
 *     dependencies is never silently served somebody else's versions.
 *
 * Tests that cannot find what they need skip themselves with a clear message
 * rather than failing, so `tools/check.sh` still reports something useful on a
 * machine that only has Node.
 */
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const CANDIDATE_GLOBS = ['/tmp/codex/*/source/node_modules', '/tmp/codex/*/node_modules'];

function roots() {
  const found = [];
  for (const glob of CANDIDATE_GLOBS) {
    const parent = path.dirname(path.dirname(glob));
    const leaf = glob.split('/').slice(-2, -1)[0];
    let entries = [];
    try {
      entries = readdirSync(parent);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith(leaf.replace('*', ''))) {
        continue;
      }
      for (const suffix of [['source', 'node_modules'], ['node_modules']]) {
        const candidate = path.join(parent, entry, ...suffix);
        if (existsSync(candidate)) {
          found.push(candidate);
        }
      }
    }
  }
  return found;
}

/* Return the absolute directory holding `packageName`, or null. */
export function findPackageDirectory(packageName) {
  for (const rootDir of roots()) {
    if (existsSync(path.join(rootDir, packageName))) {
      return rootDir;
    }
  }
  return null;
}

/* Import an optional package, or return null when it is genuinely absent. */
export function loadOptional(packageName) {
  const require = createRequire(import.meta.url);
  try {
    return require(packageName);
  } catch {
    // Fall through to the shared-host search.
  }
  const rootDir = findPackageDirectory(packageName);
  if (rootDir === null) {
    return null;
  }
  try {
    return require(path.join(rootDir, packageName));
  } catch {
    return null;
  }
}
