import { loadConfig } from "./config.js";
import { createLogger } from "./lib/logger.js";
import { createPool } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";
import { createRedisConnection } from "./queue/connection.js";
import { createWebhookQueue } from "./queue/webhookQueue.js";
import { createWebhookWorker } from "./queue/worker.js";
import { defaultProcessor } from "./processing/defaultHandler.js";
import { buildServer } from "./server.js";

const SHUTDOWN_TIMEOUT_MS = 30_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);

  const pool = createPool(config.DATABASE_URL);
  await runMigrations(pool);

  const queueConnection = createRedisConnection(config.REDIS_URL);
  const workerConnection = createRedisConnection(config.REDIS_URL);

  const queue = createWebhookQueue(queueConnection);
  const worker = createWebhookWorker({
    pool,
    connection: workerConnection,
    logger,
    maxAttempts: config.MAX_ATTEMPTS,
    process: defaultProcessor,
  });

  worker.on("error", (err) => logger.error({ err }, "worker error"));

  const app = buildServer({
    pool,
    queue,
    logLevel: config.LOG_LEVEL,
    apiKey: config.API_KEY,
    webhookSecret: config.WEBHOOK_SECRET,
    maxAttempts: config.MAX_ATTEMPTS,
    backoffBaseMs: config.BACKOFF_BASE_MS,
  });

  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  logger.info({ port: config.PORT }, "hookguard listening");

  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");

    const forceExit = setTimeout(() => {
      logger.error("graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    try {
      // Stop accepting new HTTP requests first.
      await app.close();
      // Waits for any in-flight job to finish before returning — no
      // in-flight webhook processing is dropped mid-attempt.
      await worker.close();
      await queue.close();
      await queueConnection.quit();
      await workerConnection.quit();
      await pool.end();
      logger.info("shutdown complete");
      clearTimeout(forceExit);
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "error during shutdown");
      clearTimeout(forceExit);
      process.exit(1);
    }
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
