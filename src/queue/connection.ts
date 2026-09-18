import { Redis } from "ioredis";

export function createRedisConnection(url: string): Redis {
  // BullMQ requires this to be null so it can manage retries itself.
  return new Redis(url, { maxRetriesPerRequest: null });
}
