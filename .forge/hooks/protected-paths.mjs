// Forge writes and repairs this file. It refuses an edit to a baseline-protected path.
//
// Usage: <runtime> protected-paths.mjs [--refuse-exit <code>] [--stdin-key <dot.key>]... [<path>]...
// Each <path> is a file a tool is about to edit. Each --stdin-key names where to find such a
// path in the JSON request a tool sends on standard input. The protected paths are read from
// the scaffold record Forge projects into this repository; this program holds no list.

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const RECORD = '.forge/scaffold/baseline.json';
const RULE = 'platform.protected-paths';
const ASK =
  "To change it, ask the product's operator to change the product baseline in Forge; do not edit the file.";

let refuseExit = 1;
function refuse(message) {
  process.stderr.write(`${message}\n`);
  process.exit(refuseExit);
}

const paths = [];
const stdinKeys = [];
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--refuse-exit') {
    const code = Number(args[(index += 1)]);
    if (!Number.isInteger(code) || code < 1 || code > 255) refuse('Forge hook: bad --refuse-exit.');
    refuseExit = code;
  } else if (arg === '--stdin-key') {
    const key = args[(index += 1)];
    if (!key) refuse('Forge hook: --stdin-key needs a key.');
    stdinKeys.push(key);
  } else if (arg.startsWith('--')) {
    refuse(`Forge hook: unknown option ${JSON.stringify(arg)}.`);
  } else {
    paths.push(arg);
  }
}

if (stdinKeys.length > 0) {
  let request;
  try {
    request = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    refuse('Forge refused this edit: the edit request on standard input is not JSON.');
  }
  for (const key of stdinKeys) {
    let value = request;
    for (const part of key.split('.')) {
      value = value !== null && typeof value === 'object' ? value[part] : undefined;
    }
    if (typeof value === 'string') paths.push(value);
  }
}
if (paths.length === 0) refuse('Forge refused this edit: the request names no path to check.');

// This file sits two directories below the repository root.
const root = realpathSync.native(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));

let protectedPaths;
try {
  const record = JSON.parse(readFileSync(join(root, RECORD), 'utf8'));
  protectedPaths = record.effectiveItems.find(item => item.outcomeId === RULE).value;
  if (!Array.isArray(protectedPaths) || protectedPaths.some(path => typeof path !== 'string')) {
    throw new Error('no list');
  }
} catch {
  refuse(
    `Forge refused this edit: the scaffold record ${JSON.stringify(RECORD)} is missing or unreadable, so the baseline-protected paths (rule ${RULE}) are unknown. Ask the product's operator to repair the scaffold in Forge.`
  );
}

/** The real location of a path: links are followed for as much of it as exists. */
function realLocation(path) {
  const absolute = resolve(path);
  const missing = [];
  let existing = absolute;
  for (;;) {
    try {
      return join(realpathSync.native(existing), ...missing);
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return absolute;
      missing.unshift(basename(existing));
      existing = parent;
    }
  }
}

function identity(path) {
  try {
    const stats = statSync(path);
    return stats.isFile() ? `${stats.dev}:${stats.ino}` : null;
  } catch {
    return null;
  }
}

// Letter case is ignored, because many file systems treat two spellings as one file.
const fold = path => path.toLowerCase();

for (const path of paths) {
  const location = realLocation(path);
  const inside = relative(root, location);
  const within = !inside.startsWith('..') && !isAbsolute(inside);
  const candidate = fold(inside.split(sep).join('/'));
  const sameFile = identity(location);
  const hit = protectedPaths.find(
    entry =>
      (within &&
        (candidate === '' ||
          fold(entry) === candidate ||
          fold(entry).startsWith(`${candidate}/`))) ||
      (sameFile !== null && identity(join(root, entry)) === sameFile)
  );
  if (hit !== undefined) {
    refuse(
      `Forge refused this edit: ${JSON.stringify(path)} is the baseline-protected path ${JSON.stringify(hit)} or holds it (rule ${RULE}). That file belongs to Forge: Forge writes it and repairs it, so an edit to it would be undone. ${ASK}`
    );
  }
}
