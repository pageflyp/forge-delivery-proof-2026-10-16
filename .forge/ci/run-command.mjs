// Forge owns this file. Commands are accepted catalogue data, never shell text.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
const root = realpathSync('.');
const decoded = name => JSON.parse(Buffer.from(process.env[name] ?? '', 'base64').toString('utf8'));
const safe = path => {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (rel.startsWith('..') || rel === '' || rel.startsWith('/'))
    throw Error('CI path leaves checkout');
  let current = root;
  for (const part of rel.split('/')) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink())
      throw Error('CI path crosses a link');
  }
  return absolute;
};
const write = (path, bytes) => {
  const to = safe(path);
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, bytes);
};
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const reportPath = command =>
  `.forge/ci-evidence/reports/${Buffer.from(command.id).toString('hex')}.txt`;
function execute(command, executable, argv, extra = []) {
  const cwd =
    command.workingDirectory.relativePath === '.'
      ? root
      : safe(command.workingDirectory.relativePath);
  const result = spawnSync(executable, [...argv, ...extra], {
    cwd,
    env: process.env,
    encoding: 'utf8',
    timeout: command.hardTimeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  write(reportPath(command), `${result.stdout ?? ''}${result.stderr ?? ''}`);
  if (result.error || result.status !== 0) throw Error(`Accepted command failed: ${command.id}`);
}
const mode = process.argv[2];
if (mode === 'receipt') {
  const commitSha = process.env.FORGE_COMMIT_SHA;
  if (!/^[a-f0-9]{40}$/.test(commitSha ?? '')) throw Error('Invalid qualified commit');
  const runId = Number(process.env.GITHUB_RUN_ID);
  const runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  if (
    !Number.isSafeInteger(runId) ||
    runId < 1 ||
    !Number.isSafeInteger(runAttempt) ||
    runAttempt < 1
  )
    throw Error('Invalid GitHub run identity');
  const actual = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (actual.status !== 0 || actual.stdout.trim() !== commitSha)
    throw Error('Checkout differs from qualified commit');
  const catalogue = JSON.parse(readFileSync('.forge/assurance/command-catalog.json', 'utf8'));
  const artifacts = decoded('FORGE_PACKAGE_COMMANDS').map(command => {
    const path = join(command.workingDirectory.relativePath, command.artifactPath);
    const source = safe(path);
    const bytes = readFileSync(source);
    const payloadPath = `artifacts/${Buffer.from(command.id).toString('hex')}`;
    write(`.forge/ci-evidence/release/${payloadPath}`, bytes);
    return {
      commandId: command.id,
      path,
      payloadPath,
      kind: command.artifactPath.endsWith('forge-image.manifest.json') ? 'container' : 'file',
      digest: digest(bytes),
      sizeBytes: bytes.length,
    };
  });
  if (artifacts.length === 0) throw Error('Release has no packaged artifact');
  const billsOfMaterials = decoded('FORGE_BOM_COMMANDS').map(command => {
    const artifactCommandId = command.artifactCommandId;
    const artifact = artifacts.find(a => a.commandId === artifactCommandId);
    const bytes = readFileSync(safe(reportPath(command)));
    if (!artifact || !bytes.toString('utf8').split('\n').includes(`subject ${artifact.digest}`))
      throw Error('Bill of materials does not bind artifact');
    const payloadPath = `reports/${Buffer.from(command.id).toString('hex')}.txt`;
    write(`.forge/ci-evidence/release/${payloadPath}`, bytes);
    return { commandId: command.id, artifactCommandId, payloadPath, digest: digest(bytes) };
  });
  if (billsOfMaterials.length !== artifacts.length)
    throw Error('Each artifact needs a bill of materials');
  write(
    '.forge/ci-evidence/release/release-evidence.json',
    `${JSON.stringify({ version: 1, runId, runAttempt, commitSha, catalogueHash: catalogue.contentHash, artifacts, billsOfMaterials }, null, 2)}\n`
  );
} else {
  const command = decoded('FORGE_CI_COMMAND');
  // ADR 0266 amendment 3: match notYetApplicable at Forge's commit-bound run points.
  // A scan never waits, and an untracked file cannot answer for this commit.
  const scan = command.id === 'forge-release.secret-scan' || command.baseFiles !== undefined;
  if ((mode === 'prepare' || mode === 'run') && command.appliesOnceProductFiles && !scan) {
    for (const file of command.appliesOnceProductFiles) {
      const held = spawnSync('git', ['ls-tree', '--name-only', 'HEAD', '--', file.path], {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
      });
      if (held.error || held.status !== 0)
        throw Error(`The commit could not be read for ${file.path}`);
      if (held.stdout.trim() === '') {
        const reason = `${command.id} does not apply yet: the product has no ${file.name} (${file.path}). A work item adds it.`;
        write(reportPath(command), `not_run product_file_not_yet_written: ${reason}\n`);
        console.log(reason);
        process.exit(0);
      }
    }
  }
  if (mode === 'prepare') {
    const prep = command.preparation;
    if (!prep) throw Error('Command has no preparation');
    const held = files =>
      files?.some(path => existsSync(safe(join(command.workingDirectory.relativePath, path))));
    const primary = !prep.manifests || held(prep.manifests);
    const steps = primary
      ? [
          { executable: prep.executable ?? 'uv', argv: prep.argv ?? ['sync', '--frozen'] },
          ...(prep.then ?? []),
        ]
      : (prep.alternatives?.find(alternative => held(alternative.manifests))?.steps ?? []);
    for (const step of steps) execute(command, step.executable, step.argv);
  } else if (mode === 'base') {
    const sha = process.env.FORGE_BASE_SHA;
    if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw Error('Invalid pull request base commit');
    for (const accepted of ['dependency-scan-accepted.json', 'licence-scan-accepted.json'])
      rmSync(safe(`.forge/checks/${accepted}`), { force: true });
    for (const path of command.baseFiles ?? []) {
      const result = spawnSync('git', ['show', `${sha}:${path}`], { maxBuffer: 16 * 1024 * 1024 });
      if (result.status === 0)
        write(`.forge/checks/dependency-scan-base/files/${path}`, result.stdout);
      else rmSync(safe(`.forge/checks/dependency-scan-base/files/${path}`), { force: true });
    }
    write('.forge/checks/dependency-scan-base/commit', `${sha}\n`);
  } else if (mode === 'run') {
    if (command.requiredSecretReferenceNames.length)
      throw Error('CI command cannot receive a signing key');
    // A product commit cannot manufacture Forge approval of a scan finding.
    for (const accepted of ['dependency-scan-accepted.json', 'licence-scan-accepted.json'])
      rmSync(safe(`.forge/checks/${accepted}`), { force: true });
    const base =
      command.baseFiles?.length && process.env.FORGE_CI_PROFILE === 'change'
        ? readFileSync('.forge/checks/dependency-scan-base/commit', 'utf8').trim()
        : null;
    execute(command, command.executable, command.argv, base ? ['--base', base] : []);
  } else throw Error('Unknown CI runner mode');
}
