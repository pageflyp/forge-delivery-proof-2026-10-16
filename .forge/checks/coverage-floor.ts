// Forge owns this file and replaces it on repair. It runs the measured command, then
// reads the coverage report that command wrote, and fails unless every source file was
// measured and the share of covered lines is at least the floor. The floor and the
// source scope are arguments of a Forge-rendered command; no file of the product sets them.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { matchesGlob, relative, resolve, sep } from "node:path";

function fail(message: string): never {
  console.error(`coverage floor: ${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const split = argv.indexOf("--");
const measured = split < 0 ? [] : argv.slice(split + 1);
const options = split < 0 ? [] : argv.slice(0, split);
const single = new Map<string, string>();
const excluded: string[] = [];
for (let at = 0; at < options.length; at += 2) {
  const name = options[at] ?? "";
  const value = options[at + 1];
  if (value === undefined) fail(`option ${name} has no value`);
  if (name === "--exclude") excluded.push(value);
  else if (single.has(name)) fail(`option ${name} is given twice`);
  else single.set(name, value);
}
function option(name: string): string {
  const value = single.get(name);
  if (value === undefined) fail(`option ${name} is required`);
  single.delete(name);
  return value;
}
const floorText = option("--floor");
const report = option("--report");
const sourceRoot = option("--source-root");
const sourcePattern = option("--source-pattern");
if (single.size > 0) fail(`unknown option ${[...single.keys()].join(", ")}`);
const [program, ...programArguments] = measured;
if (program === undefined) fail("no measured command is given after --");
if (!/^(0(\.\d+)?|1(\.0+)?)$/.test(floorText)) {
  fail(`the floor must be a share from 0 to 1, not "${floorText}"`);
}
const floor = Number(floorText);

// A report from an earlier run must never answer for this one.
rmSync(report, { force: true });
const run = spawnSync(program, programArguments, { stdio: "inherit" });
if (run.error) fail(`the measured command did not start: ${run.error.message}`);
if (run.status !== 0) fail(`the measured command failed with ${String(run.status ?? run.signal)}`);
if (!existsSync(report)) fail(`unmeasured: the measured command wrote no report at ${report}`);

// The report is input like any other: anything not understood is unmeasured, never a pass.
function malformed(line: number, reason: string): never {
  fail(`unmeasured: the report is malformed at line ${String(line)}: ${reason}`);
}
const portable = (path: string): string => relative(".", resolve(path)).split(sep).join("/");
const records = new Map<string, { found: number; hit: number }>();
let open: { file: string; found?: number; hit?: number } | null = null;
let lineNumber = 0;
for (const raw of readFileSync(report, "utf8").split("\n")) {
  lineNumber += 1;
  const line = raw.trim();
  if (line.startsWith("SF:")) {
    if (open) malformed(lineNumber, "a record starts inside another");
    open = { file: portable(line.slice(3)) };
  } else if (line.startsWith("LF:") || line.startsWith("LH:")) {
    if (!open) malformed(lineNumber, "a line count has no file");
    const count = line.slice(3);
    if (!/^\d+$/.test(count)) malformed(lineNumber, "a line count is not a whole number");
    const key = line.startsWith("LF:") ? "found" : "hit";
    if (open[key] !== undefined) malformed(lineNumber, "a line count is given twice");
    open[key] = Number(count);
  } else if (line === "end_of_record") {
    if (!open) malformed(lineNumber, "a record ends before it starts");
    const { file, found, hit } = open;
    if (found === undefined || hit === undefined) malformed(lineNumber, "no line counts");
    if (hit > found) malformed(lineNumber, "more lines are hit than found");
    if (records.has(file)) malformed(lineNumber, `${file} is recorded twice`);
    records.set(file, { found, hit });
    open = null;
  }
}
if (open) malformed(lineNumber, "the last record never ends");

// The measured scope: every source file must be in the report, so a file no test loads
// cannot leave the sum. Only the exclusions given in the command arguments are allowed.
const sources = existsSync(sourceRoot)
  ? readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => portable(resolve(entry.parentPath, entry.name)))
      .filter((file) => {
        const inRoot = relative(sourceRoot, file).split(sep).join("/");
        return (
          matchesGlob(inRoot, sourcePattern) &&
          !excluded.some((pattern) => matchesGlob(inRoot, pattern))
        );
      })
      .sort()
  : [];
const missing = sources.filter((file) => !records.has(file));
if (missing.length > 0) {
  fail(`unmeasured: no test loads these source files: ${missing.join(", ")}`);
}
let found = 0;
let hit = 0;
for (const file of sources) {
  found += records.get(file)?.found ?? 0;
  hit += records.get(file)?.hit ?? 0;
}
if (found === 0) fail("unmeasured: the report has no measured lines in the source files");
const share = hit / found;
const summary = `lines ${String(share)} (${String(hit)} of ${String(found)}) floor ${floorText}`;
if (share < floor) fail(`${summary}: below the floor`);
console.log(`coverage floor: ${summary}`);
