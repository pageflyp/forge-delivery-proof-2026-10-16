// Forge owns this file and replaces it on repair. It is the dependency scan of a component
// (Product CI/CD ticket 09). OSV-Scanner reads the dependency files; this file gets the
// vulnerability data, applies the severity threshold and compares the change with its base.
//
//   fetch  The install step. It downloads the vulnerability data, and it is the only step
//          with network.
//   judge  The scan. It has no network. With `--base`, a finding that the base also has
//          does not fail. Forge alone gives `--base`, and Forge writes the base files.
//          A finding that a live Deviation accepts does not fail either (ticket 11). Forge
//          writes the list of accepted findings for each run and replaces any copy of it.
//
// Anything this file does not understand fails the scan: an unknown argument, a tool error,
// a severity it cannot read, or a dependency file that is not there.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const HOST = 'osv-vulnerabilities.storage.googleapis.com';
const TOOL = 'osv-scanner';
const CHECKS = dirname(fileURLToPath(import.meta.url));
const DATABASE = join(CHECKS, 'dependency-scan-db');
const BASE = join(CHECKS, 'dependency-scan-base');
const CONFIG = join(CHECKS, 'osv-scanner.toml');
const ACCEPTED = join(CHECKS, 'dependency-scan-accepted.json');
// A download that does not reach the host is tried this many times, one second apart.
const DOWNLOAD_ATTEMPTS = 3;
const ECOSYSTEMS = {
  'bun.lock': 'npm',
  'package-lock.json': 'npm',
  'pnpm-lock.yaml': 'npm',
  'yarn.lock': 'npm',
  'uv.lock': 'PyPI',
  'requirements.txt': 'PyPI',
  'Gemfile.lock': 'RubyGems',
};
const LEVELS = ['low', 'medium', 'high', 'critical'];

function fail(message) {
  console.log(`result fail: ${message}`);
  process.exit(1);
}

function options(argv) {
  const lockfiles = [];
  const single = new Map();
  for (let at = 0; at < argv.length; at += 2) {
    const name = argv[at];
    const value = argv[at + 1];
    if (value === undefined) fail(`option ${name} has no value`);
    if (name === '--lockfile') lockfiles.push(value);
    else if ((name === '--fail-on' || name === '--base') && !single.has(name))
      single.set(name, value);
    else fail(`option ${name} is unknown or given twice`);
  }
  if (lockfiles.length === 0) fail('no dependency file is declared');
  for (const file of lockfiles) {
    const inside = relative('.', resolve(file));
    if (inside.startsWith('..') || resolve(file) === resolve('.')) {
      fail(`dependency file ${file} is outside the checkout`);
    }
    if (ecosystemOf(file) === undefined) fail(`dependency file ${file} is of no known kind`);
  }
  return { lockfiles, failOn: single.get('--fail-on'), base: single.get('--base') };
}

function ecosystemOf(file) {
  return ECOSYSTEMS[file.split('/').at(-1)];
}

const archiveOf = ecosystem => join(DATABASE, 'osv-scalibr', ecosystem, 'all.zip');
const baseFileOf = file => join(BASE, 'files', file);
const bytesOf = file => (existsSync(file) ? readFileSync(file) : null);

/** The base commit whose files Forge wrote, or null when Forge wrote none. */
function writtenBase() {
  const commit = bytesOf(join(BASE, 'commit'))?.toString('utf8').trim();
  return commit && /^[0-9a-f]{40}$/.test(commit) ? commit : null;
}

/** Whether each declared dependency file has the bytes it has at the base. */
function unchanged(lockfiles) {
  return lockfiles.every(file => {
    const now = bytesOf(file);
    const then = bytesOf(baseFileOf(file));
    return now === null ? then === null : then !== null && now.equals(then);
  });
}

async function fetchDatabases(lockfiles) {
  // Data that the checkout brings is not Forge's data: the scan reads a download or nothing.
  rmSync(DATABASE, { recursive: true, force: true });
  // With no changed dependency file the scan does not run, so it needs no data.
  if (writtenBase() !== null && unchanged(lockfiles)) {
    console.log('dependency-scan fetch: no dependency file changed, so nothing is downloaded');
    return;
  }
  for (const ecosystem of [...new Set(lockfiles.map(ecosystemOf))].sort()) {
    const target = archiveOf(ecosystem);
    mkdirSync(dirname(target), { recursive: true });
    await download(ecosystem, target);
    console.log(`dependency-scan fetch: ${ecosystem}`);
  }
}

async function download(ecosystem, target) {
  for (let attempt = 1; ; attempt += 1) {
    let response;
    try {
      response = await fetch(`https://${HOST}/${ecosystem}/all.zip`, { redirect: 'error' });
      if (response.ok && response.body) {
        await pipeline(Readable.fromWeb(response.body), createWriteStream(`${target}.part`));
        renameSync(`${target}.part`, target);
        return;
      }
    } catch (error) {
      if (attempt >= DOWNLOAD_ATTEMPTS) throw error;
      await sleep(1_000);
      continue;
    }
    // The host answered: another try gets the same answer.
    throw new Error(`the data of ${ecosystem} gave status ${String(response.status)}`);
  }
}

/** An error's message and, when Node keeps the reason apart, the reason. */
function reasonOf(error) {
  if (!(error instanceof Error)) return '';
  const cause = error.cause instanceof Error ? error.cause.message || error.cause.code : undefined;
  return cause ? `${error.message} (${String(cause)})` : error.message;
}

async function digestOf(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return `sha256:${hash.digest('hex')}`;
}

function toolVersion() {
  const run = spawnSync(TOOL, ['--version'], { encoding: 'utf8' });
  const version = /^osv-scanner version: (\S+)$/m.exec(run.stdout ?? '')?.[1];
  if (run.status !== 0 || version === undefined) fail('the scan tool did not state its version');
  return version;
}

function levelOf(score) {
  const number = score === '' ? Number.NaN : Number(score);
  if (!(number > 0 && number <= 10)) return 'unknown';
  return number >= 9 ? 'critical' : number >= 7 ? 'high' : number >= 4 ? 'medium' : 'low';
}

/** The findings of the tool for the files that exist, as it stated them. */
function scan(files, displayed) {
  const present = files.filter(file => existsSync(file));
  if (present.length === 0) return null;
  const run = spawnSync(
    TOOL,
    [
      'scan',
      'source',
      '--offline',
      '--offline-vulnerabilities',
      '--format',
      'json',
      '--verbosity',
      'error',
      // The config is Forge's: a config file of the product cannot accept a finding.
      '--config',
      CONFIG,
      ...present.flatMap(file => ['-L', file]),
    ],
    {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: DATABASE },
    }
  );
  // 0: no finding. 1: findings. 128: the files hold no package. Anything else is an error.
  if (run.status === 128) return { status: 128, findings: [] };
  if (run.status !== 0 && run.status !== 1) {
    const said = (run.stderr ?? '').trim().split('\n').slice(-3).join(' | ').slice(0, 600);
    fail(`the scan tool stopped with ${String(run.status ?? run.signal ?? run.error)}: ${said}`);
  }
  let report;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    fail('the scan tool gave a report that is not JSON');
  }
  if (!Array.isArray(report?.results)) fail('the scan tool gave a report with no result list');
  const findings = [];
  for (const result of report.results) {
    const path = result?.source?.path;
    const file = present.find(candidate => resolve(candidate) === path);
    if (file === undefined) fail('the scan tool reported a file that was not given');
    for (const entry of result.packages ?? []) {
      const { name, version, ecosystem } = entry?.package ?? {};
      if (![name, version, ecosystem].every(text => typeof text === 'string')) {
        fail('the scan tool reported a package with no name, version or ecosystem');
      }
      for (const group of entry.groups ?? []) {
        const ids = (group?.ids ?? []).filter(id => typeof id === 'string').sort();
        if (ids.length === 0) fail('the scan tool reported a finding with no ID');
        findings.push({
          ids,
          name,
          version,
          ecosystem,
          score: typeof group.max_severity === 'string' ? group.max_severity : '',
          file: displayed(file),
        });
      }
    }
  }
  if (run.status === 1 && findings.length === 0) {
    fail('the scan tool reported a failure and no finding');
  }
  return { status: run.status, findings };
}

/**
 * The findings that live Deviations accept: each names one ID and one version of one package,
 * and an expiry. A list that Forge did not write is none. A list that is not whole fails the
 * scan, and so does a name that is a pattern: a Deviation never accepts more than one finding.
 */
function acceptedFindings() {
  if (!existsSync(ACCEPTED)) return [];
  const said = 'the list of accepted findings is not valid';
  let list;
  try {
    list = JSON.parse(readFileSync(ACCEPTED, 'utf8'))?.findings;
  } catch {
    fail(said);
  }
  if (!Array.isArray(list)) fail(said);
  const name = /^[A-Za-z0-9_./:@+=~-]+$/;
  const now = Date.now();
  const live = [];
  for (const entry of list) {
    const parts = [
      entry?.id,
      entry?.package,
      entry?.version,
      entry?.deviationId,
      entry?.approverId,
    ];
    if (!parts.every(text => typeof text === 'string' && name.test(text))) fail(said);
    const until = Date.parse(entry.expiresAt);
    if (typeof entry.expiresAt !== 'string' || Number.isNaN(until)) fail(said);
    if (until > now) live.push(entry);
  }
  return live;
}

async function judge({ lockfiles, failOn, base }) {
  if (!LEVELS.includes(failOn)) fail(`--fail-on takes one of: ${LEVELS.join(', ')}`);
  const accepted = acceptedFindings();
  if (base !== undefined) {
    if (!/^[0-9a-f]{40}$/.test(base)) fail('the base is not a commit ID');
    // Forge writes the base files and names the commit. A base with no files is not judged.
    if (writtenBase() !== base) fail('the files of the base commit are not there');
  }
  console.log(`base ${base ?? 'none'}`);
  console.log(`threshold ${failOn}`);
  if (!lockfiles.some(file => existsSync(file))) {
    fail(`no declared dependency file is there: ${lockfiles.join(', ')}`);
  }
  if (base !== undefined && unchanged(lockfiles)) {
    console.log('result pass: no dependency file changed since the base; no scan ran');
    return;
  }
  console.log(`dependency-scan ${TOOL} ${toolVersion()}`);
  for (const ecosystem of [...new Set(lockfiles.map(ecosystemOf))].sort()) {
    const archive = archiveOf(ecosystem);
    if (!existsSync(archive)) fail(`the vulnerability data of ${ecosystem} is not there`);
    console.log(`database ${JSON.stringify([ecosystem, await digestOf(archive)])}`);
  }
  const change = scan(lockfiles, file => file);
  if (change.status === 128) fail('the dependency files hold no package the scan tool reads');
  // The base is judged in the same run, with the same data.
  const known = new Set();
  if (base !== undefined) {
    const before = scan(lockfiles.map(baseFileOf), file => relative(join(BASE, 'files'), file));
    for (const finding of before?.findings ?? []) {
      for (const id of finding.ids)
        known.add(JSON.stringify([finding.ecosystem, finding.name, id]));
    }
  }
  const limit = LEVELS.indexOf(failOn);
  let failing = 0;
  for (const finding of change.findings) {
    const level = levelOf(finding.score);
    const inBase = finding.ids.some(id =>
      known.has(JSON.stringify([finding.ecosystem, finding.name, id]))
    );
    // A severity the tool does not state is not below any threshold.
    const fails = level === 'unknown' || LEVELS.indexOf(level) >= limit;
    // One finding: an ID of the group, the package and its version.
    const deviation = accepted.find(
      entry =>
        entry.package === finding.name &&
        entry.version === finding.version &&
        finding.ids.includes(entry.id)
    );
    // A finding that a live Deviation accepts is accepted, also when the base has it: Forge
    // reports a base finding as work on the release (ticket 12), and an accepted one is not.
    const kind = fails && deviation ? 'accepted' : inBase ? 'base' : !fails ? 'below' : 'new';
    if (kind === 'new') failing += 1;
    console.log(
      `finding ${JSON.stringify([kind, finding.ids[0], finding.ecosystem, finding.name, finding.version, level, finding.file])}`
    );
    if (kind === 'accepted') {
      console.log(
        `accepted ${JSON.stringify([deviation.deviationId, deviation.id, deviation.package, deviation.version, deviation.approverId, deviation.expiresAt])}`
      );
    }
  }
  if (failing > 0) {
    fail(
      `${String(failing)} finding${failing === 1 ? '' : 's'} at or above "${failOn}"${base === undefined ? '' : ' that the base does not have'}`
    );
  }
  console.log('result pass');
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'fetch') {
  const { lockfiles, failOn, base } = options(rest);
  if (failOn !== undefined || base !== undefined) fail('fetch takes dependency files only');
  try {
    await fetchDatabases(lockfiles);
  } catch (error) {
    rmSync(DATABASE, { recursive: true, force: true });
    fail(`the vulnerability data did not download: ${reasonOf(error)}`);
  }
} else if (mode === 'judge') {
  await judge(options(rest));
} else {
  fail('the mode is fetch or judge');
}
