import { randomUUID } from "node:crypto";
import pino from "pino";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Worker } from "bullmq";
import { insertReceived, getById } from "../src/db/deliveries.js";
import { createWebhookQueue, enqueueDelivery } from "../src/queue/webhookQueue.js";
import { createWebhookWorker } from "../src/queue/worker.js";
import { closeTestPool, getTestPool, truncateAll } from "./helpers/db.js";
import { flushTestRedis, newTestRedisConnection } from "./helpers/redis.js";

const logger = pino({ level: "silent" });

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("graceful shutdown", () => {
  it("waits for an in-flight job to finish before closing, without losing it", async () => {
    const pool = await getTestPool();
    const queueConnection = newTestRedisConnection();
    const workerConnection = newTestRedisConnection();
    const queue = createWebhookQueue(queueConnection);
    const PROCESSING_DELAY_MS = 400;

    const { delivery } = await insertReceived(pool, {
      source: "test",
      deliveryId: randomUUID(),
      payload: {},
      headers: {},
    });

    let processingStarted = false;
    let processingFinished = false;
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });

    worker = createWebhookWorker({
      pool,
      connection: workerConnection,
      logger,
      maxAttempts: 3,
      process: async () => {
        processingStarted = true;
        resolveStarted();
        await sleep(PROCESSING_DELAY_MS);
        processingFinished = true;
      },
    });

    await enqueueDelivery(
      queue,
      { deliveryId: delivery.id, source: "test" },
      { maxAttempts: 3, backoffBaseMs: 20 },
    );

    // Simulate SIGTERM landing while the job is actively being processed.
    await started;
    expect(processingStarted).toBe(true);
    expect(processingFinished).toBe(false);

    const closeStartedAt = Date.now();
    await worker.close();
    const closeDurationMs = Date.now() - closeStartedAt;

    // close() must not resolve until the in-flight job actually finished.
    expect(processingFinished).toBe(true);
    expect(closeDurationMs).toBeGreaterThanOrEqual(PROCESSING_DELAY_MS - 50);

    const record = await getById(pool, delivery.id);
    expect(record?.status).toBe("succeeded");

    worker = undefined; // already closed
    await queue.close();
    await queueConnection.quit();
    await workerConnection.quit();
  });
});
