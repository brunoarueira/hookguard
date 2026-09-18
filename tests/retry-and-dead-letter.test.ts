import { randomUUID } from "node:crypto";
import pino from "pino";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Worker } from "bullmq";
import { insertReceived, getById } from "../src/db/deliveries.js";
import { createWebhookQueue, enqueueDelivery } from "../src/queue/webhookQueue.js";
import { createWebhookWorker } from "../src/queue/worker.js";
import { closeTestPool, getTestPool, truncateAll } from "./helpers/db.js";
import { flushTestRedis, newTestRedisConnection } from "./helpers/redis.js";
import { waitForStatus } from "./helpers/wait.js";

const logger = pino({ level: "silent" });
const BACKOFF_BASE_MS = 20; // fast retries for the test

let worker: Worker | undefined;

beforeEach(async () => {
  await truncateAll();
  await flushTestRedis();
});

afterEach(async () => {
  await worker?.close();
  worker = undefined;
});

afterAll(async () => {
  await closeTestPool();
});

describe("retry with exponential backoff", () => {
  it("succeeds once the underlying failure clears, after retrying", async () => {
    const pool = await getTestPool();
    const queueConnection = newTestRedisConnection();
    const workerConnection = newTestRedisConnection();
    const queue = createWebhookQueue(queueConnection);
    const maxAttempts = 4;

    const { delivery } = await insertReceived(pool, {
      source: "test",
      deliveryId: randomUUID(),
      payload: {},
      headers: {},
    });

    let calls = 0;
    worker = createWebhookWorker({
      pool,
      connection: workerConnection,
      logger,
      maxAttempts,
      process: async () => {
        calls += 1;
        if (calls < 3) throw new Error(`simulated failure #${calls}`);
      },
    });

    await enqueueDelivery(
      queue,
      { deliveryId: delivery.id, source: "test" },
      { maxAttempts, backoffBaseMs: BACKOFF_BASE_MS },
    );

    const finalStatus = await waitForStatus(pool, delivery.id, [
      "succeeded",
      "dead_lettered",
    ]);

    expect(finalStatus).toBe("succeeded");
    expect(calls).toBe(3);

    const record = await getById(pool, delivery.id);
    expect(record?.attempts).toBe(3);
    expect(record?.lastError).toBeNull();

    await queue.close();
    await queueConnection.quit();
    await workerConnection.quit();
  });
});

describe("dead-lettering", () => {
  it("moves a delivery to dead_lettered after exhausting all attempts", async () => {
    const pool = await getTestPool();
    const queueConnection = newTestRedisConnection();
    const workerConnection = newTestRedisConnection();
    const queue = createWebhookQueue(queueConnection);
    const maxAttempts = 3;

    const { delivery } = await insertReceived(pool, {
      source: "test",
      deliveryId: randomUUID(),
      payload: {},
      headers: {},
    });

    let calls = 0;
    worker = createWebhookWorker({
      pool,
      connection: workerConnection,
      logger,
      maxAttempts,
      process: async () => {
        calls += 1;
        throw new Error("always fails");
      },
    });

    await enqueueDelivery(
      queue,
      { deliveryId: delivery.id, source: "test" },
      { maxAttempts, backoffBaseMs: BACKOFF_BASE_MS },
    );

    const finalStatus = await waitForStatus(pool, delivery.id, [
      "succeeded",
      "dead_lettered",
    ]);

    expect(finalStatus).toBe("dead_lettered");
    expect(calls).toBe(maxAttempts);

    const record = await getById(pool, delivery.id);
    expect(record?.attempts).toBe(maxAttempts);
    expect(record?.lastError).toContain("always fails");

    // No further attempts should show up after dead-lettering.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(calls).toBe(maxAttempts);

    await queue.close();
    await queueConnection.quit();
    await workerConnection.quit();
  });
});
