import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default("info"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  API_KEY: z.string().min(1),
  WEBHOOK_SECRET: z.string().min(1),
  MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  BACKOFF_BASE_MS: z.coerce.number().int().positive().default(1000),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return parsed.data;
}
