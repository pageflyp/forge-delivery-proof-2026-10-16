import { expect, test } from "bun:test";
import { greet } from "../src";

test("greets by name", () => {
  expect(greet("Forge")).toBe("Hello Forge");
});
