import { expect, test } from "bun:test";
import { migrate } from "../src/migrate";

test("migrate finishes", async () => {
  await expect(migrate()).resolves.toBeUndefined();
});

// The entry point itself: Forge runs it with `bun run migrate` before the app starts.
test("migrates from its entry point", () => {
  const ran = Bun.spawnSync(["bun", "src/migrate.ts"], {
    cwd: `${import.meta.dir}/..`,
  });
  expect(ran.exitCode).toBe(0);
});
