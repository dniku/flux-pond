/*
 * Locate optional test dependencies that are not installed in this project.
 *
 * There is no network here, so `npm install` is not an option; jsdom and
 * Playwright already exist in a shared `node_modules` on this host. ESM ignores
 * NODE_PATH, so the path has to be resolved absolutely.
 *
 * Tests that need these must call `describeMissing()` and skip themselves with a
 * clear message rather than failing, so `tools/check.sh` still reports a useful
 * result on a machine that only has Node.
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
  const rootDir = findPackageDirectory(packageName);
  if (rootDir !== null) {
    return require(path.join(rootDir, packageName));
  }
  try {
    return require(packageName);
  } catch {
    return null;
  }
}
