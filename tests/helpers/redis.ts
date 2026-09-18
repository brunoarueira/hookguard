import { createRedisConnection } from "../../src/queue/connection.js";

const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379";

export function newTestRedisConnection() {
  return createRedisConnection(TEST_REDIS_URL);
}

export async function flushTestRedis(): Promise<void> {
  const conn = newTestRedisConnection();
  await conn.flushdb();
  await conn.quit();
}
