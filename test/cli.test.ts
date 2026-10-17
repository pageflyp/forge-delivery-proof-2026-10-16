import { expect, spyOn, test } from "bun:test";
import { main } from "../src/cli";

/** Runs the command with its output captured. */
function run(argv: string[]) {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    const code = main(argv);
    return {
      code,
      out: log.mock.calls.flat().join("\n"),
      err: error.mock.calls.flat().join("\n"),
    };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

test("greets by name", () => {
  expect(run(["Forge"])).toEqual({ code: 0, out: "Hello Forge", err: "" });
});

test("asks for a name", () => {
  expect(run([])).toEqual({ code: 2, out: "", err: "usage: cli <name>" });
});

test("shows its usage and its version", () => {
  expect(run(["--help"]).out).toContain("usage: cli <name>");
  expect(run(["--version"])).toEqual({ code: 0, out: "cli 0.1.0", err: "" });
});

test("refuses what it does not understand", () => {
  const bad = [
    ["--nope"],
    ["Forge", "Forge"],
    [""],
    ["   "],
    ["a".repeat(101)],
  ];
  for (const argv of bad) {
    const result = run(argv);
    expect(result.code).toBe(2);
    expect(result.out).toBe("");
    expect(result.err).not.toBe("");
  }
});

test("takes a name that starts with a dash after --", () => {
  expect(run(["--", "-Forge"])).toEqual({
    code: 0,
    out: "Hello -Forge",
    err: "",
  });
});
