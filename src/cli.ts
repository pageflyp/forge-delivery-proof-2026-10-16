#!/usr/bin/env bun
// The command-line entry point: one command with one argument.
const USAGE = `usage: cli <name>

  -h, --help   show this text
  --version    show the version`;
const MAX_NAME = 100;

function fail(message: string): number {
  console.error(`cli: ${message}\nTry: cli --help`);
  return 2;
}

export function main(argv: readonly string[]): number {
  const [first] = argv;
  if (first === "-h" || first === "--help") {
    console.log(USAGE);
    return 0;
  }
  if (first === "--version") {
    console.log("cli 0.1.0");
    return 0;
  }
  // Words before "--" are options, and this tool has none. After "--", every word is a value.
  const dash = argv.indexOf("--");
  const options = dash === -1 ? argv : argv.slice(0, dash);
  const unknown = options.find((word) => word.startsWith("-"));
  if (unknown !== undefined) return fail(`unknown option: ${unknown}`);
  const [name, ...extra] =
    dash === -1 ? argv : [...options, ...argv.slice(dash + 1)];
  if (name === undefined) {
    console.error("usage: cli <name>");
    return 2;
  }
  if (extra.length > 0) return fail("cli takes one name");
  if (name.trim() === "") return fail("the name must not be blank");
  if ([...name].length > MAX_NAME)
    return fail(`the name is longer than ${MAX_NAME} characters`);
  console.log(`Hello ${name}`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
