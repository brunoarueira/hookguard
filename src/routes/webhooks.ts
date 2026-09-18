import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { Queue } from "bullmq";
import * as deliveriesDb from "../db/deliveries.js";
import { verifySignature } from "../lib/signature.js";
import { enqueueDelivery, type WebhookJobData } from "../queue/webhookQueue.js";

export interface WebhookRoutesDeps {
  pool: Pool;
  queue: Queue<WebhookJobData>;
  apiKey: string;
  webhookSecret: string;
  maxAttempts: number;
  backoffBaseMs: number;
}

function extractDeliveryId(
  headers: Record<string, unknown>,
  body: unknown,
): string | undefined {
  const header = headers["x-webhook-delivery-id"];
  if (typeof header === "string" && header.length > 0) return header;

  if (body && typeof body === "object" && "id" in body) {
    const id = (body as Record<string, unknown>).id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return undefined;
}

export function registerWebhookRoutes(
  app: FastifyInstance,
  deps: WebhookRoutesDeps,
): void {
  app.post<{ Params: { source: string } }>(
    "/webhooks/:source",
    async (request, reply) => {
      const { source } = request.params;
      const signature = request.headers["x-webhook-signature"];
      const rawBody = request.rawBody ?? Buffer.alloc(0);

      const valid = verifySignature(
        rawBody,
        typeof signature === "string" ? signature : undefined,
        deps.webhookSecret,
      );
      if (!valid) {
        return reply.code(401).send({ error: "invalid or missing signature" });
      }

      const deliveryId = extractDeliveryId(
        request.headers as Record<string, unknown>,
        request.body,
      );
      if (!deliveryId) {
        return reply.code(400).send({
          error:
            "missing delivery id: provide x-webhook-delivery-id header or an 'id' field in the payload",
        });
      }

      const { delivery, created } = await deliveriesDb.insertReceived(
        deps.pool,
        {
          source,
          deliveryId,
          payload: request.body,
          headers: request.headers as Record<string, unknown>,
        },
      );

      if (created) {
        await enqueueDelivery(
          deps.queue,
          { deliveryId: delivery.id, source },
          { maxAttempts: deps.maxAttempts, backoffBaseMs: deps.backoffBaseMs },
        );
        request.log.info(
          { deliveryId: delivery.id, source },
          "webhook received and enqueued",
        );
        return reply.code(202).send({ id: delivery.id, status: delivery.status });
      }

      request.log.info(
        { deliveryId: delivery.id, source },
        "duplicate delivery, not re-enqueued",
      );
      return reply.code(200).send({ id: delivery.id, status: delivery.status });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/webhooks/:id/status",
    async (request, reply) => {
      const apiKey = request.headers["x-api-key"];
      if (apiKey !== deps.apiKey) {
        return reply.code(401).send({ error: "unauthorized" });
      }

      const delivery = await deliveriesDb.getById(deps.pool, request.params.id);
      if (!delivery) {
        return reply.code(404).send({ error: "delivery not found" });
      }

      return reply.send({
        id: delivery.id,
        source: delivery.source,
        deliveryId: delivery.deliveryId,
        status: delivery.status,
        attempts: delivery.attempts,
        lastError: delivery.lastError,
        createdAt: delivery.createdAt,
        updatedAt: delivery.updatedAt,
      });
    },
  );
}
