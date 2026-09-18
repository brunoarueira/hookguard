# 2. Idempotency via a Postgres unique constraint, not a Redis dedupe cache

## Status

Accepted

## Context

Webhook senders retry deliveries on timeout or a non-2xx response, and
the retried delivery carries the same delivery ID as the original. A
retried delivery must not be processed twice, so something has to
recognize "I've already seen this ID" before a job is enqueued.

Two natural places to put that check:

1. **Redis**, using `SET key NX` keyed on `(source, deliveryId)` — cheap
   and fast, and BullMQ already depends on Redis so no new
   infrastructure is needed.
2. **Postgres**, using a `UNIQUE (source, delivery_id)` constraint on
   the `deliveries` table that already has to exist to answer
   `GET /webhooks/:id/status`.

Redis-based dedupe is attractive for pure throughput, but it introduces
a second source of truth that has to stay consistent with Postgres: a
dedupe key with a TTL can expire and let a very late retry through, and
a crash between "set the Redis key" and "commit the Postgres row"
leaves the two disagreeing about whether a delivery was actually
accepted. The status endpoint has to read from Postgres regardless, so
Postgres already has to be the durable record.

## Decision

Dedupe on the `deliveries` table itself: `INSERT ... ON CONFLICT
(source, delivery_id) DO NOTHING RETURNING *`. If a row comes back, this
is a new delivery — enqueue it. If no row comes back, the pair already
existed — fetch it and return its current status without enqueueing.
This is one round trip, atomic by construction (the constraint is
enforced by Postgres itself, not by a check-then-insert race in
application code), and has no expiry to reason about — a delivery ID is
deduped for as long as its row exists, permanently.

BullMQ's own job ID (set to the same internal delivery UUID) adds a
second, cheaper layer of protection at the queue level, but it is a
convenience, not the source of truth — see `src/db/deliveries.ts`
(`insertReceived`) and `src/queue/webhookQueue.ts`.

## Consequences

One code path and one durable table answer both "is this a duplicate?"
and "what's the status of delivery X?" — no cache/DB consistency
question to reason about, and no silent reprocessing window from a
dedupe key expiring under load. The cost is a DB round trip on every
inbound webhook instead of an in-memory Redis check, which is the right
tradeoff at webhook volumes (this is not a hot path processing
thousands of requests per second) and is a cost every request already
pays via `INSERT` regardless of dedupe strategy.
