# 3. Retry/backoff and dead-lettering decided inside the job processor, not a 'failed' event listener

## Status

Accepted

## Context

BullMQ already implements retries with exponential backoff natively
(`attempts` + `backoff: { type: 'exponential' }` on the job), and
re-enqueues a failed job automatically up to the attempt limit. What it
doesn't give for free is *dead-lettering*: recording, in hookguard's own
terms, that a delivery has permanently failed after exhausting retries.

The obvious place to hook that is a `worker.on('failed', ...)` listener,
since BullMQ emits `failed` on every failed attempt, not just the last
one. But that listener runs as a separate event handler, decoupled in
time from the attempt that produced it — under concurrency it has to
independently re-derive "was this the last attempt?" from job state
that the processor already computed, and any bug in that
re-derivation (or an ordering assumption that doesn't hold) produces a
delivery that's actually exhausted but never marked dead-lettered, or
vice versa.

## Decision

Compute "is this the last attempt?" inside the processor itself, where
`job.attemptsMade` and the job's configured `attempts` are already in
scope, and branch synchronously:

- Processing throws, attempt < limit → mark the delivery `failed` in
  Postgres, then rethrow. BullMQ sees the throw and schedules the next
  attempt per its own backoff timer.
- Processing throws, attempt == limit → mark the delivery
  `dead_lettered` directly and **return normally** (don't rethrow).
  BullMQ has no further retries to schedule regardless, so resolving
  the job avoids relying on a second, separate `failed`-event handler
  agreeing about which attempt was terminal.

See `src/queue/worker.ts`.

## Consequences

The state transition and the attempt that caused it are decided in one
place, in one synchronous flow — no event-ordering assumptions, no
duplicate "was this the last attempt" logic to keep in sync between a
processor and a listener. The tradeoff is the processor now owns a
piece of queue-policy knowledge (the attempt limit) that BullMQ also
knows about via job options; this is duplicated by reading
`job.opts.attempts` at call time rather than hand-copying a constant, so
the two can't drift.

`MAX_ATTEMPTS` and the exponential backoff base delay are both
operator-configured (`MAX_ATTEMPTS`, `BACKOFF_BASE_MS`), not
domain-specific — this decision generalizes to any BullMQ-backed
at-least-once processor with a required dead-letter step, independent
of what hookguard's webhook payloads actually contain.
