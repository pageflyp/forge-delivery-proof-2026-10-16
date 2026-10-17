#!/usr/bin/env node
// Forge-owned runner for cli-matrix.json. Runs under Node 22 or Bun, no dependencies.
// usage: bun cli-runner.mjs <cli-matrix.json> <commands.json> <repoDir> [out.json]
// Every call runs in a fresh sandbox: empty cwd, empty HOME, empty TMPDIR, no TTY, closed stdin, a timeout.
// The repo is copied once (node_modules and .venv are linked, not copied; with no .venv, UV_PROJECT_ENVIRONMENT is linked as .venv). {repo} in run.argv is replaced with the copy.
// Exit code: 0 when no row fails, 1 when a row fails or the run aborts, 2 for a bad call or a bad commands file.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

const [matrixPath, tablePath, repoDir, outPath] = process.argv.slice(2);
if (!matrixPath || !tablePath || !repoDir) {
  console.error('usage: cli-runner.mjs <cli-matrix.json> <commands.json> <repoDir> [out.json]');
  process.exit(2);
}
const matrix = JSON.parse(readFileSync(matrixPath, 'utf8'));
const table = JSON.parse(readFileSync(tablePath, 'utf8'));
if (!Array.isArray(table.commands) || !table.commands.length || !Array.isArray(table.run?.argv)) {
  console.error(`${tablePath} must declare run.argv and at least one command`);
  process.exit(2);
}
const VS = matrix.valueSets;
const kinds = Object.fromEntries(matrix.caseKinds.map(k => [k.id, k]));
const rows = [];
const t0 = Date.now();

function record(caseId, status, where, evidence) {
  const sev = kinds[caseId].severity;
  const final = status === 'fail' && sev === 'warn' ? 'warn' : status;
  rows.push({ case: caseId, where, status: final, evidence: String(evidence).slice(0, 240) });
}
const na = (caseId, where, reason) => record(caseId, 'na', where, reason);
const skip = (caseId, where) => record(caseId, 'skipped', where, `call cap ${VS.callCap} reached`);

// ---- sandbox
const root = mkdtempSync(join(process.env.CLI_PROBE_TMP ?? os.tmpdir(), 'cli-probe-'));
const repoCopy = join(root, 'repo');
// Not copied: git history, installed packages (linked below) and coverage output.
cpSync(repoDir, repoCopy, {
  recursive: true,
  verbatimSymlinks: true,
  filter: s => {
    const r = relative(repoDir, s);
    return !/^(node_modules|\.venv|coverage)(\/|$)/.test(r) && !/(^|\/)\.git(\/|$)/.test(r);
  },
});
// The sandbox keeps the Python environment outside the checkout and names it in UV_PROJECT_ENVIRONMENT.
for (const [dir, target] of [
  ['node_modules', join(repoDir, 'node_modules')],
  ['.venv', existsSync(join(repoDir, '.venv')) ? join(repoDir, '.venv') : process.env.UV_PROJECT_ENVIRONMENT],
]) if (target && existsSync(target)) symlinkSync(resolve(target), join(repoCopy, dir));
const sha = b => createHash('sha256').update(b).digest('hex');

function walk(base, prefix, out) {
  let names;
  try {
    names = readdirSync(base).sort();
  } catch {
    return;
  }
  for (const n of names) {
    if (prefix === '' && (n === 'node_modules' || n === '.venv') && base === repoCopy) continue;
    const p = join(base, n);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    const key = prefix + n;
    if (st.isDirectory()) {
      out.set(key + '/', 'd');
      walk(p, key + '/', out);
    } else if (st.isSymbolicLink()) out.set(key, 'l');
    else {
      let h = 'unreadable';
      try {
        h = sha(readFileSync(p));
      } catch {}
      out.set(key, `${st.mode & 0o777}:${st.size}:${h}`);
    }
  }
}
const tree = sb => {
  const m = new Map();
  walk(sb.cwd, '', m);
  walk(sb.home, '~/', m);
  walk(sb.tmp, '$TMP/', m);
  return m;
};
const diff = (a, b) => {
  const keys = new Set([...a.keys(), ...b.keys()]);
  return [...keys].filter(k => a.get(k) !== b.get(k)).sort();
};

const repoStart = new Map();
walk(repoCopy, '', repoStart);

function makeSandbox(files = {}) {
  const dir = mkdtempSync(join(root, 'c-'));
  const sb = { dir, cwd: join(dir, 'cwd'), home: join(dir, 'home'), tmp: join(dir, 'tmp') };
  for (const d of [sb.cwd, sb.home, sb.tmp]) mkdirSync(d);
  for (const [name, spec] of Object.entries(files)) {
    const p = join(sb.cwd, name);
    mkdirSync(dirname(p), { recursive: true });
    if (spec && spec.dir) {
      mkdirSync(p, { recursive: true });
      continue;
    }
    let buf;
    if (typeof spec === 'string') buf = Buffer.from(spec);
    else if (spec.bytes) buf = Buffer.from(spec.bytes);
    else if (spec.fill !== undefined) buf = Buffer.alloc(spec.size, spec.fill);
    else buf = Buffer.from(spec.text ?? '');
    writeFileSync(p, buf);
    if (spec && typeof spec === 'object' && spec.mode !== undefined) chmodSync(p, spec.mode);
  }
  return sb;
}

// ---- declared writes
const globRe = g =>
  new RegExp(
    '^' +
      g
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '\u0000')
        .replace(/\*/g, '[^/]*')
        .replace(/\u0000/g, '.*') +
      '$'
  );
const writeRes = (table.writes ?? []).map(globRe);
const declaredWrite = key => writeRes.some(re => re.test(key));

// ---- one process
const TIMEOUT = table.timeoutMs ?? 8000;
const TRACE = VS.tracePatterns.map(p => new RegExp(p, 'm'));
const traceLine = text => {
  for (const re of TRACE) {
    const m = text.match(re);
    if (m) return m[0].trim().slice(0, 100);
  }
  return null;
};

function exec(sb, argv, { env = {}, stdin = 'closed', stdinBytes } = {}) {
  return new Promise(resolve => {
    const [exe, ...args] = argv;
    const start = Date.now();
    const child = spawn(exe, args, {
      cwd: sb.cwd,
      env: { PATH: process.env.PATH, HOME: sb.home, TMPDIR: sb.tmp, USER: 'probe', LANG: 'en_US.UTF-8', NO_COLOR: '1', CI: '1', TERM: 'dumb', ...VS.runtimeEnv, ...env },
      detached: true,
      stdio: [stdin === 'closed' ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError = null;
    const room = s => s.length < 1_000_000;
    child.stdout.on('data', d => room(stdout) && (stdout += d));
    child.stderr.on('data', d => room(stderr) && (stderr += d));
    if (child.stdin) {
      child.stdin.on('error', () => {});
      if (stdin === 'bytes') child.stdin.end(stdinBytes);
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }, TIMEOUT);
    child.on('error', e => (spawnError = e.message));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
      resolve({ code, signal, timedOut, stdout, stderr, spawnError, ms: Date.now() - start });
    });
  });
}

let calls = 0;
const observed = [];
// run(): fresh sandbox (or a given one), optional setup calls, then the judged call.
async function run(label, { argv, files, setup = [], env, stdin, stdinBytes, sb: given, keep = false }) {
  calls += 1 + setup.length;
  if (calls > VS.callCap) return null;
  const sb = given ?? makeSandbox(files);
  let setupFailed = null;
  for (const s of setup) {
    const sr = await exec(sb, s);
    if (sr.code !== 0 && !setupFailed) setupFailed = `setup ${s.slice(-2).join(' ')} exit ${sr.code ?? sr.signal}: ${sr.stderr.trim().slice(0, 80)}`;
  }
  const before = tree(sb);
  const r = await exec(sb, argv, { env, stdin, stdinBytes });
  const changed = diff(before, tree(sb));
  const out = { ...r, changed, setupFailed, label, argv, sb };
  observed.push(out);
  if (!keep && !given) rmSync(sb.dir, { recursive: true, force: true });
  return out;
}

// ---- argv building
const runArgv = () => table.run.argv.map(a => a.replaceAll('{repo}', repoCopy));
const cmdTokens = (cmd, values) => cmd.argv.map(t => t.replace(/\{(\w+)\}/g, (_, n) => values[n] ?? `{${n}}`));
const exFiles = cmd => cmd.example.files ?? {};
const setupArgvs = cmd => (cmd.example.setup ?? []).map(a => [...runArgv(), ...cmdTokens({ argv: a }, cmd.example.values)]);
const callCmd = (label, cmd, { values = {}, files = {}, tokens, prefix = [], ...rest } = {}) =>
  run(label, {
    argv: [...runArgv(), ...prefix, ...(tokens ?? cmdTokens(cmd, { ...cmd.example.values, ...values }))],
    files: { ...exFiles(cmd), ...files },
    setup: setupArgvs(cmd),
    ...rest,
  });
const callBare = (label, extra = [], opts = {}) => run(label, { argv: [...runArgv(), ...extra], ...opts });

// ---- judging
const exitText = r => (r.signal ? `signal ${r.signal}` : `exit ${r.code}`);
function common(r) {
  const why = [];
  if (r.spawnError) why.push(`spawn: ${r.spawnError}`);
  if (r.timedOut) why.push(`timed out after ${TIMEOUT} ms`);
  if (r.signal && !r.timedOut) why.push(`killed by ${r.signal}`);
  const t = traceLine(r.stdout) ?? traceLine(r.stderr);
  if (t) why.push(`trace: ${t}`);
  const u = r.changed.filter(k => !k.endsWith('/') && !declaredWrite(k));
  if (u.length) why.push(`wrote outside declared: ${u.slice(0, 3).join(', ')}`);
  return why;
}
const handled = r => {
  const why = common(r);
  if (r.code !== 0 && !r.timedOut && !r.signal && !r.stderr.trim()) why.push(`${exitText(r)} with no message`);
  return why;
};
const rejected = r => {
  const why = common(r);
  if (r.code === 0) why.push('exit 0');
  if (!r.stderr.trim()) why.push('no message on stderr');
  if (r.stdout.trim()) why.push('stdout not empty');
  if (r.changed.length) why.push(`tree changed: ${r.changed.slice(0, 3).join(', ')}`);
  return why;
};
const sample = r => {
  const s = (r.stderr.trim() || r.stdout.trim()).split('\n')[0].slice(0, 70);
  return s ? `${exitText(r)} "${s}"` : exitText(r);
};
function judge(caseId, where, r, why, okNote) {
  if (!r) return skip(caseId, where);
  if (why.length) return record(caseId, 'fail', where, `${why.join('; ')} | ${sample(r)}`);
  record(caseId, 'pass', where, okNote ?? sample(r));
}

const cmds = table.commands;
const args = type => cmds.flatMap(c => c.args.filter(a => (Array.isArray(type) ? type : [type]).includes(a.type)).map(a => [c, a]));
const inRange = (a, v) => {
  const n = Number(v);
  return v.trim() !== '' && Number.isInteger(n) && (a.min === undefined || n >= a.min) && (a.max === undefined || n <= a.max);
};
const sampleContent = (cmd, arg) => {
  const f = cmd.example.values[arg.name];
  const spec = exFiles(cmd)[f];
  return typeof spec === 'string' ? spec : (spec?.text ?? 'x\n');
};

// ---- rows
const base = {};
let aborted = false;
for (const cmd of cmds) {
  const r = await callCmd(`${cmd.id}: example`, cmd);
  base[cmd.id] = r;
  const ex = cmd.example;
  const why = r ? common(r) : [];
  if (r?.setupFailed) why.push(r.setupFailed);
  if (r && r.code !== (ex.exit ?? 0)) why.push(`expected exit ${ex.exit ?? 0}, got ${exitText(r)}`);
  if (r && ex.stdout && !new RegExp(ex.stdout).test(r.stdout)) why.push(`stdout does not match ${ex.stdout}`);
  judge('run.example', cmd.id, r, why);
  if (r?.spawnError || r?.code === 127) aborted = true;
}

if (!aborted) {
  const c0 = cmds[0];
  const b0 = base[c0.id];

  // usage
  const noArgs = await callBare('no args');
  if (noArgs) {
    const expectUsage = table.noArgs === 'usage';
    judge('usage.no-args', `declared ${table.noArgs}`, noArgs, expectUsage ? rejected(noArgs) : handled(noArgs));
    const silent = noArgs.code === 0 && !noArgs.stdout.trim() && !noArgs.stderr.trim();
    if (expectUsage) na('usage.silent-success', 'no args', 'covered by usage.no-args (declared usage)');
    else record('usage.silent-success', silent ? 'fail' : 'pass', 'no args', silent ? 'exit 0 with no output on either stream' : sample(noArgs));
  } else {
    skip('usage.no-args', 'no args');
    skip('usage.silent-success', 'no args');
  }
  for (const flag of ['--help', '-h']) {
    const r = await callBare(flag, [flag]);
    const why = r ? common(r) : [];
    if (r && r.code !== 0) why.push(`${exitText(r)}, not 0`);
    if (r && !r.stdout.trim()) why.push('no usage text on stdout');
    judge('usage.help', flag, r, why);
  }
  {
    const r = await callBare('--version', ['--version']);
    const why = r ? common(r) : [];
    if (r && r.code !== 0) why.push(`${exitText(r)}, not 0`);
    if (r && r.stdout.trim().split('\n').length !== 1) why.push('stdout is not one line');
    judge('usage.version', '--version', r, why);
  }
  if (table.acceptsUnknownFlags) na('usage.unknown-flag', VS.unknownFlag, 'acceptsUnknownFlags is declared');
  else {
    const r = await callBare('unknown flag', [VS.unknownFlag]);
    judge('usage.unknown-flag', VS.unknownFlag, r, r ? rejected(r) : []);
  }
  if (!table.subcommands) na('usage.unknown-subcommand', VS.unknownSubcommand, 'the tool declares no subcommands');
  else {
    const r = await callBare('unknown subcommand', [VS.unknownSubcommand]);
    judge('usage.unknown-subcommand', VS.unknownSubcommand, r, r ? rejected(r) : []);
  }

  // path arguments
  const isRoot = process.getuid?.() === 0;
  const pathArgs = args('path');
  if (!pathArgs.length) {
    for (const id of ['path.missing', 'path.directory', 'path.unreadable', 'path.message-accurate', 'path.content', 'path.odd-names', 'usage.double-dash'])
      na(id, 'all commands', 'no path argument declared');
  }
  for (const [cmd, arg] of pathArgs) {
    const w = `${cmd.id} <${arg.name}>`;
    const text = sampleContent(cmd, arg);
    const target = n => ({ [arg.name]: n });
    const wantExit = cmd.example.exit ?? 0;
    const msgSources = [];

    let r = await callCmd(`${w}: missing`, cmd, { values: target('forge-probe-missing.txt') });
    judge('path.missing', w, r, r ? rejected(r) : []);

    if (arg.mustBeFile === false) na('path.directory', w, 'a directory is a valid value');
    else {
      r = await callCmd(`${w}: directory`, cmd, { values: target('forge-probe-dir'), files: { 'forge-probe-dir': { dir: true } } });
      judge('path.directory', w, r, r ? rejected(r) : []);
      if (r) msgSources.push(['directory', r]);
    }
    if (isRoot) na('path.unreadable', w, 'the runner is root; mode 000 does not block root');
    else {
      r = await callCmd(`${w}: unreadable`, cmd, { values: target('forge-probe-locked.txt'), files: { 'forge-probe-locked.txt': { text, mode: 0 } } });
      judge('path.unreadable', w, r, r ? rejected(r) : []);
      if (r) msgSources.push(['unreadable', r]);
    }
    if (!msgSources.length) na('path.message-accurate', w, 'no directory or unreadable call');
    for (const [name, mr] of msgSources) {
      const hit = new RegExp(VS.missingPathWords, 'i').exec(mr.stderr);
      record('path.message-accurate', hit ? 'fail' : 'pass', `${w} ${name}`, hit ? `path exists but stderr says "${hit[0]}" | ${sample(mr)}` : sample(mr));
    }

    const bin = Array.from({ length: VS.binaryBytes }, (_, i) => i % 256);
    for (const [name, spec] of [
      ['empty file', ''],
      ['binary file', { bytes: bin }],
      ['invalid UTF-8', { bytes: VS.invalidUtf8 }],
      ['32 MB file', { fill: 0x61, size: VS.largeFileBytes }],
    ]) {
      r = await callCmd(`${w}: ${name}`, cmd, { values: target('forge-probe-content.bin'), files: { 'forge-probe-content.bin': spec } });
      judge('path.content', `${w} ${name}`, r, r ? handled(r) : []);
    }

    for (const name of VS.oddFileNames) {
      r = await callCmd(`${w}: ${name}`, cmd, { values: target(name), files: { [name]: text } });
      const why = r ? common(r) : [];
      if (r && r.code !== wantExit) why.push(`expected exit ${wantExit}, got ${exitText(r)}`);
      judge('path.odd-names', `${w} "${name}"`, r, why);
    }

    const vals = { ...cmd.example.values, ...target('-forge-dash.txt') };
    const tokens = cmdTokens(cmd, vals);
    tokens.splice(Math.max(0, cmd.argv.findIndex(t => t.includes(`{${arg.name}}`))), 0, '--');
    r = await callCmd(`${w}: after --`, cmd, { tokens, files: { '-forge-dash.txt': text } });
    const why = r ? common(r) : [];
    if (r && r.code !== wantExit) why.push(`expected exit ${wantExit}, got ${exitText(r)}`);
    judge('usage.double-dash', w, r, why);
  }

  // value arguments
  const valueArgs = args(['string', 'integer', 'enum', 'path']);
  for (const [cmd, a] of valueArgs) {
    const w = `${cmd.id} <${a.name}>`;
    const put = v => ({ values: { [a.name]: v } });
    // limits.declared: a limit passes. No limit with a reason is a warning that shows the reason. No limit and no reason fails.
    const limited =
      a.type === 'string' ? a.max !== undefined
      : a.type === 'integer' ? a.min !== undefined && a.max !== undefined
      : a.type === 'enum' ? Array.isArray(a.values) && a.values.length > 0
      : a.maxBytes !== undefined;
    const missing = { string: 'no max', integer: 'no min/max', enum: 'no values', path: 'no maxBytes' }[a.type];
    if (limited) record('limits.declared', 'pass', w, 'declared');
    else if (a.type !== 'enum' && a.unbounded) record('limits.declared', 'warn', w, `unbounded: ${a.unbounded}`);
    else record('limits.declared', 'fail', w, a.type === 'enum' ? missing : `${missing} and no unbounded reason`);

    if (a.type === 'string' || a.type === 'path') {
      for (const v of VS.stringBlank) {
        const r = await callCmd(`${w}: blank ${JSON.stringify(v)}`, cmd, put(v));
        judge('input.blank', `${w} ${JSON.stringify(v)}`, r, r ? (a.required ? rejected(r) : handled(r)) : []);
      }
    }
    if (a.type === 'integer') {
      for (const v of VS.integerBad.filter(v => !inRange(a, v))) {
        const r = await callCmd(`${w}: ${v}`, cmd, put(v));
        judge('input.wrong-type', `${w} ${JSON.stringify(v)}`, r, r ? rejected(r) : []);
      }
      for (const v of [a.min - 1, a.max + 1].filter(Number.isFinite).map(String)) {
        const r = await callCmd(`${w}: ${v}`, cmd, put(v));
        judge('input.out-of-range', `${w} ${v}`, r, r ? rejected(r) : []);
      }
    }
    if (a.type === 'enum') {
      const r = await callCmd(`${w}: not a value`, cmd, put('forge-probe-not-a-value'));
      judge('input.out-of-range', `${w} not-a-value`, r, r ? rejected(r) : []);
    }
    if (a.type === 'string') {
      if (a.max === undefined) na('input.over-length', w, `unbounded: ${a.unbounded ?? 'no limit declared'}`);
      else
        for (const n of [a.max + 1, VS.overLongExtra].filter((n, i, all) => (i === 0 || n > a.max + 1) && all.indexOf(n) === i)) {
          const r = await callCmd(`${w}: ${n} chars`, cmd, put('a'.repeat(n)));
          judge('input.over-length', `${w} ${n} chars`, r, r ? rejected(r) : []);
        }
    }
  }
  if (!args('string').length) na('input.over-length', 'all commands', 'no string argument declared');
  if (!args('integer').length) {
    na('input.wrong-type', 'all commands', 'no integer argument declared');
    na('input.out-of-range', 'all commands', 'no integer or enum argument declared');
  }
  if (!args(['string', 'path']).length) na('input.blank', 'all commands', 'no string or path argument declared');

  // stdin
  if (table.stdin === 'unsupported') {
    const r = await callCmd(`${c0.id}: stdin held open`, c0, { stdin: 'open' });
    const why = r ? common(r) : [];
    judge('stdin.no-hang', c0.id, r, why, `finished in ${r?.ms} ms`);
  } else na('stdin.no-hang', c0.id, `stdin is ${table.stdin}; waiting for input may be correct`);
  {
    const garbage = randomBytes(VS.stdinGarbageBytes);
    const r = await callCmd(`${c0.id}: 1 MB on stdin`, c0, { stdin: 'bytes', stdinBytes: garbage });
    const why = r ? handled(r) : [];
    if (r && b0 && table.stdin === 'unsupported' && r.stdout !== b0.stdout) why.push('stdout changed although stdin is unsupported');
    judge('stdin.garbage', c0.id, r, why);
  }

  // entities and effects
  for (const cmd of cmds) {
    const w = cmd.id;
    if (!cmd.target) {
      na('entity.missing', w, 'no target declared');
    } else {
      const r = await callCmd(`${w}: missing target`, cmd, { values: { [cmd.target.arg]: cmd.target.missing } });
      judge('entity.missing', w, r, r ? rejected(r) : []);
    }
    if (cmd.kind === 'delete' && cmd.target) {
      const sb = makeSandbox(exFiles(cmd));
      const first = await callCmd(`${w}: delete`, cmd, { sb, keep: true });
      const second = first && (await callCmd(`${w}: delete again`, cmd, { sb, setup: [] }));
      const why = first && first.code !== 0 ? [`first delete ${exitText(first)}`] : [];
      judge('entity.delete-twice', w, second, [...why, ...(second ? rejected(second) : [])]);
      rmSync(sb.dir, { recursive: true, force: true });
    } else na('entity.delete-twice', w, 'not a delete command with a target');
    const b = base[cmd.id];
    if (cmd.kind === 'read') {
      na('effect.valid-changes-state', w, 'read command');
      judge('read.no-write', w, b, b ? (b.changed.length ? [`tree changed: ${b.changed.slice(0, 3).join(', ')}`] : []) : [], 'tree unchanged');
    } else {
      na('read.no-write', w, `${cmd.kind} command`);
      judge('effect.valid-changes-state', w, b, b ? (b.code !== 0 ? [`example ${exitText(b)}`] : b.changed.length ? [] : ['exit 0 and the tree did not change']) : [], `changed ${b?.changed.length} paths`);
    }
  }

  // hooks
  for (const spec of VS.hookEnvNames) {
    const [name, value = '1'] = spec.split('=');
    if ((table.declaredEnv ?? []).includes(name)) {
      na('hooks.env', spec, 'declared in declaredEnv');
      continue;
    }
    const r = await callCmd(`${c0.id}: env ${spec}`, c0, { env: { [name]: value } });
    const why = r ? common(r) : [];
    if (r && b0 && r.code !== b0.code) why.push(`exit ${r.code}, example ${b0.code}`);
    if (r && b0 && r.stdout !== b0.stdout) why.push('stdout differs from the example');
    judge('hooks.env', `${name}=${value}`, r, why, 'same exit and stdout as the example');
  }
  for (const flag of VS.hookFlags) {
    if ((table.declaredFlags ?? []).includes(flag)) {
      na('hooks.argv', flag, 'declared in declaredFlags');
      continue;
    }
    const r = await callBare(`flag ${flag}`, [flag]);
    let why = r ? rejected(r) : [];
    const ignored = r && noArgs && r.code === noArgs.code && r.stdout === noArgs.stdout;
    if (ignored && !common(r).length) why = [];
    judge('hooks.argv', flag, r, why, r ? `${exitText(r)} (${ignored ? 'ignored' : 'rejected'})` : undefined);
  }

  // secrets
  {
    const secret = `forge-probe-${randomBytes(8).toString('hex')}`;
    const env = { FORGE_PROBE_SECRET_1: secret };
    const rs = [
      await callCmd(`${c0.id}: secret example`, c0, { env }),
      await callBare('secret no args', [], { env }),
      await callBare('secret --help', ['--help'], { env }),
      await callBare('secret unknown flag', [VS.unknownFlag], { env }),
    ].filter(Boolean);
    const leak = rs.find(r => r.stdout.includes(secret) || r.stderr.includes(secret));
    if (!rs.length) skip('secrets.not-echoed', 'env FORGE_PROBE_SECRET_1');
    else record('secrets.not-echoed', leak ? 'fail' : 'pass', 'env FORGE_PROBE_SECRET_1', leak ? `secret appeared in "${leak.label}"` : `${rs.length} calls, secret absent`);
  }
}

// ---- aggregated rows over every call
const traced = observed.filter(o => traceLine(o.stdout) ?? traceLine(o.stderr));
if (!traced.length) record('output.no-trace', 'pass', `all ${observed.length} calls`, 'no trace or runtime banner');
for (const o of traced.slice(0, 5)) record('output.no-trace', 'fail', o.label, `${exitText(o)} | ${traceLine(o.stdout) ?? traceLine(o.stderr)}`);
if (traced.length > 5) record('output.no-trace', 'fail', `${traced.length - 5} more calls`, 'more calls matched; first 5 listed');

const repoEnd = new Map();
walk(repoCopy, '', repoEnd);
const writers = observed.map(o => [o, o.changed.filter(k => !k.endsWith('/') && !declaredWrite(k))]).filter(([, u]) => u.length);
const repoChanged = diff(repoStart, repoEnd).filter(k => !k.endsWith('/'));
if (!writers.length && !repoChanged.length) record('sandbox.writes-only-declared', 'pass', `all ${observed.length} calls`, `writes allowed: ${(table.writes ?? []).join(', ') || 'none'}`);
for (const [o, u] of writers.slice(0, 5)) record('sandbox.writes-only-declared', 'fail', o.label, `wrote ${u.slice(0, 3).join(', ')}`);
if (repoChanged.length) record('sandbox.writes-only-declared', 'fail', 'repo copy', `changed ${repoChanged.slice(0, 3).join(', ')}`);

rmSync(root, { recursive: true, force: true });

const count = s => rows.filter(r => r.status === s).length;
const result = {
  matrix: matrix.id,
  commandsFile: tablePath,
  product: table.product,
  ranAt: new Date().toISOString(),
  seconds: Math.round((Date.now() - t0) / 100) / 10,
  calls,
  summary: { pass: count('pass'), fail: count('fail'), warn: count('warn'), na: count('na'), skipped: count('skipped') },
  verdict: count('fail') || aborted ? 'fail' : 'pass',
  rows,
};
if (outPath) writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result.summary), 'verdict', result.verdict, `${result.calls} calls ${result.seconds}s`);
for (const r of rows.filter(r => r.status === 'fail' || r.status === 'warn')) console.log(`${r.status.toUpperCase().padEnd(4)} ${r.case}  ${r.where}  ${r.evidence}`);
if (aborted) console.log('ABORT the tool did not start: fix run.argv in the commands file');
process.exitCode = result.verdict === 'pass' ? 0 : 1;
