import { Queue } from "bullmq";
import type { Redis } from "ioredis";

export const WEBHOOK_QUEUE_NAME = "webhook-deliveries";

export interface WebhookJobData {
  deliveryId: string;
  source: string;
}

export function createWebhookQueue(connection: Redis): Queue<WebhookJobData> {
  return new Queue<WebhookJobData>(WEBHOOK_QUEUE_NAME, { connection });
}

export async function enqueueDelivery(
  queue: Queue<WebhookJobData>,
  data: WebhookJobData,
  opts: { maxAttempts: number; backoffBaseMs: number },
): Promise<void> {
  await queue.add("process", data, {
    // Same id as the DB row: a duplicate enqueue for an already-queued
    // delivery is a no-op at the BullMQ level too.
    jobId: data.deliveryId,
    attempts: opts.maxAttempts,
    backoff: { type: "exponential", delay: opts.backoffBaseMs },
    removeOnComplete: { age: 60 * 60 * 24 * 7 }, // keep 7 days for inspection
    removeOnFail: false,
  });
}
