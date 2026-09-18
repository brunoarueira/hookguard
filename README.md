# hookguard

A small, production-shaped inbound webhook receiver: signature
verification, idempotent delivery, retry with exponential backoff, and
dead-lettering after repeated failure. TypeScript, Fastify, PostgreSQL,
Redis/BullMQ.

The domain doesn't matter here — no webhook payload is actually acted
on. What this project demonstrates is the reliability pattern around
receiving webhooks: the part that's easy to get subtly wrong (dropping
a delivery mid-retry, double-processing a resend, losing an in-flight
job on deploy).

## Quickstart

```bash
cp .env.example .env   # then set API_KEY and WEBHOOK_SECRET
docker compose up --build
```

That builds and runs three services (Postgres, Redis, the app),
running DB migrations automatically on boot. The API is then live at
`http://localhost:3000`.

```bash
curl http://localhost:3000/health
```

## API

**`POST /webhooks/:source`** — receive a webhook.

- `x-webhook-signature: sha256=<hex hmac-sha256 of the raw body>`,
  keyed with `WEBHOOK_SECRET`. Missing or invalid → `401`.
- Delivery ID: `x-webhook-delivery-id` header, or an `id` field in the
  JSON body if the header isn't present. Missing both → `400`.
- First time seeing this `(source, deliveryId)` pair → `202`, job
  enqueued. Already seen it → `200`, not re-enqueued (this is the
  idempotency guarantee — see [ADR 0002](docs/adr/0002-postgres-idempotency-key.md)).

```bash
BODY='{"event":"push"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | sed 's/^.* //')
curl -X POST http://localhost:3000/webhooks/github \
  -H "Content-Type: application/json" \
  -H "x-webhook-delivery-id: dlv-001" \
  -H "x-webhook-signature: sha256=$SIG" \
  -d "$BODY"
```

**`GET /webhooks/:id/status`** — check a delivery's processing status.
Requires `x-api-key: $API_KEY`. Returns `received` / `processing` /
`succeeded` / `failed` (mid-retry) / `dead_lettered`, plus attempt
count and the last error if any.

## Design decisions

Full reasoning lives in [`docs/adr/`](docs/adr/) — short version:

- **Idempotency** is a Postgres `UNIQUE (source, delivery_id)`
  constraint, not a Redis dedupe cache with a TTL. One durable table
  answers both "is this a duplicate?" and "what's this delivery's
  status?", with no expiry window where a very late retry slips
  through. ([ADR 0002](docs/adr/0002-postgres-idempotency-key.md))
- **Retry/backoff** is BullMQ's native exponential backoff
  (`MAX_ATTEMPTS`, `BACKOFF_BASE_MS`). The decision of whether a given
  failure is retryable or terminal is made synchronously inside the
  job processor itself — not in a separate `'failed'` event listener —
  so there's no race between "which attempt was this" and "did we
  record it right." ([ADR 0003](docs/adr/0003-retry-backoff-dead-letter-in-processor.md))
- **Signature verification** runs over the raw request bytes, captured
  before Fastify's JSON parser touches them — re-serializing a parsed
  body is not guaranteed to reproduce what the sender actually signed.
  ([ADR 0004](docs/adr/0004-raw-body-capture-for-signature-verification.md))
- **Graceful shutdown** closes things in a specific order on
  `SIGTERM`: stop accepting HTTP → let the worker finish its
  in-flight job (BullMQ's `worker.close()` waits for this) → close the
  queue and Redis connections → close the DB pool. A delivery that was
  actively processing when the signal arrived is allowed to finish; one
  that was merely queued is picked up by the next process to start,
  courtesy of BullMQ's own job persistence.
  ([ADR 0005](docs/adr/0005-graceful-shutdown-ordering.md))

Every state transition (`received`, `processing`, `succeeded`,
`failed`, `dead_lettered`) is written to a `delivery_events` audit
table and logged as structured JSON, so any delivery's full history
can be reconstructed independent of log retention.

## Testing

```bash
docker compose up -d postgres redis
npm test
```

Tests run against real Postgres/Redis (no mocking), covering: dedupe
on retried delivery IDs, retry-then-succeed under exponential backoff,
dead-lettering after exhausting attempts, and that `worker.close()`
genuinely waits for an in-flight job before resolving rather than
dropping it.

## Configuration

See `.env.example`. Everything is env-driven: `DATABASE_URL`,
`REDIS_URL`, `API_KEY` (shared key for the status endpoint),
`WEBHOOK_SECRET` (HMAC key for inbound signatures), `MAX_ATTEMPTS`,
`BACKOFF_BASE_MS`.

## Scope

Single shared API key, no multi-tenant auth. One webhook `source`
namespace pattern (`:source` in the URL), trivially extended — adding
a second source is a routing concern, not a schema change. No UI.
