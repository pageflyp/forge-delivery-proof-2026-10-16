// Brings the schema of this app's database up to date. Forge runs `bun run migrate` once
// the database accepts connections: before the app starts in an environment, and before
// the integration test. It runs each time, so each step must be safe to run again, such as
// `CREATE TABLE IF NOT EXISTS`. Forge runs it only for a component that uses a database.
export const migrate = async (): Promise<void> => {};

if (import.meta.main) await migrate();
