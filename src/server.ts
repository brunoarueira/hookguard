import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { Queue } from "bullmq";
import { loggerOptions } from "./lib/logger.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import type { WebhookJobData } from "./queue/webhookQueue.js";

export interface BuildServerDeps {
  pool: Pool;
  queue: Queue<WebhookJobData>;
  logLevel: string;
  apiKey: string;
  webhookSecret: string;
  maxAttempts: number;
  backoffBaseMs: number;
}

export function buildServer(deps: BuildServerDeps): FastifyInstance {
  const app = Fastify({ logger: loggerOptions(deps.logLevel) });

  // Capture the raw bytes before JSON parsing: signature verification must
  // run over exactly what the sender signed, not a re-serialized copy.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (request, body, done) => {
      request.rawBody = body as Buffer;
      if (body.length === 0) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse((body as Buffer).toString("utf8")));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.get("/health", async () => ({ status: "ok" }));

  registerWebhookRoutes(app, {
    pool: deps.pool,
    queue: deps.queue,
    apiKey: deps.apiKey,
    webhookSecret: deps.webhookSecret,
    maxAttempts: deps.maxAttempts,
    backoffBaseMs: deps.backoffBaseMs,
  });

  return app;
}
