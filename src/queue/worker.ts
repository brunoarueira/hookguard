import { Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import type { Logger } from "../lib/logger.js";
import * as deliveries from "../db/deliveries.js";
import { WEBHOOK_QUEUE_NAME, type WebhookJobData } from "./webhookQueue.js";

export type DeliveryProcessor = (
  delivery: deliveries.Delivery,
) => Promise<void>;

export interface WorkerDeps {
  pool: Pool;
  connection: Redis;
  logger: Logger;
  maxAttempts: number;
  process: DeliveryProcessor;
  concurrency?: number;
}

/**
 * Runs the retry/backoff/dead-letter state machine. Attempt bookkeeping and
 * the terminal transition (succeeded / failed-will-retry / dead_lettered)
 * are decided here rather than in a BullMQ 'failed' listener, so the
 * decision is made synchronously with the attempt instead of racing a
 * separate event.
 */
export function createWebhookWorker(deps: WorkerDeps): Worker<WebhookJobData> {
  const { pool, connection, logger, maxAttempts, process: processFn } = deps;

  return new Worker<WebhookJobData>(
    WEBHOOK_QUEUE_NAME,
    async (job: Job<WebhookJobData>) => {
      const record = await deliveries.getById(pool, job.data.deliveryId);
      if (!record) {
        // Nothing to do — the row is gone (should not happen in practice).
        logger.warn({ deliveryId: job.data.deliveryId }, "delivery not found, skipping");
        return;
      }

      if (record.status === "succeeded") {
        logger.info({ deliveryId: record.id }, "already succeeded, skipping");
        return;
      }

      const attempt = job.attemptsMade + 1;
      const attemptLimit = (job.opts.attempts as number | undefined) ?? maxAttempts;

      await deliveries.markProcessing(pool, record.id, attempt);
      logger.info(
        { deliveryId: record.id, source: record.source, attempt, attemptLimit },
        "processing delivery",
      );

      try {
        await processFn(record);
        await deliveries.markSucceeded(pool, record.id);
        logger.info({ deliveryId: record.id, attempt }, "delivery succeeded");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const isLastAttempt = attempt >= attemptLimit;

        if (isLastAttempt) {
          await deliveries.markDeadLettered(pool, record.id, message);
          logger.error(
            { deliveryId: record.id, attempt, error: message },
            "delivery dead-lettered after exhausting retries",
          );
          // Resolve rather than throw: BullMQ would not retry further
          // anyway, and we've already recorded the terminal state.
          return;
        }

        await deliveries.markFailed(pool, record.id, message);
        logger.warn(
          { deliveryId: record.id, attempt, attemptLimit, error: message },
          "delivery attempt failed, will retry",
        );
        throw err;
      }
    },
    { connection, concurrency: deps.concurrency ?? 5 },
  );
}
