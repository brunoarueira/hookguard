import { Pool } from "pg";
import { runMigrations } from "../../src/db/migrate.js";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://hookguard:hookguard@localhost:5432/hookguard";

let pool: Pool | undefined;

export async function getTestPool(): Promise<Pool> {
  if (!pool) {
    pool = new Pool({ connectionString: TEST_DATABASE_URL });
    await runMigrations(pool);
  }
  return pool;
}

export async function truncateAll(): Promise<void> {
  const db = await getTestPool();
  await db.query(
    "TRUNCATE TABLE delivery_events, deliveries RESTART IDENTITY CASCADE",
  );
}

export async function closeTestPool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
