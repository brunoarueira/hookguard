# 5. Graceful shutdown: HTTP first, then the worker, then infrastructure

## Status

Accepted

## Context

On `SIGTERM` (a container orchestrator stopping the process, a
deploy rolling forward) an in-flight webhook delivery must not be lost:
either it finishes processing and reaches a terminal state, or it's
left in a state a future worker can pick back up. Getting the shutdown
sequence wrong in either direction causes real damage — closing the
Postgres pool or Redis connection before an active job finishes drops
that job mid-write; closing the HTTP server last accepts new work after
the process has already decided to stop.

## Decision

Shut down in this fixed order (`src/index.ts`):

1. **`app.close()`** — stop accepting new HTTP connections and let any
   in-flight HTTP request finish. No new webhooks can be accepted from
   this point.
2. **`worker.close()`** — BullMQ's default (non-forced) close stops
   pulling new jobs from the queue but *waits for the currently active
   job to finish* before resolving. This is the step that keeps an
   in-flight delivery from being dropped mid-processing.
3. **`queue.close()`** and both Redis connections (`queueConnection`,
   `workerConnection`) — safe now that nothing is producing or
   consuming jobs.
4. **`pool.end()`** — safe last, since the worker (the only thing
   still writing to Postgres by this point) has already stopped.

A `SHUTDOWN_TIMEOUT_MS` watchdog (`setTimeout` calling `process.exit(1)`,
`unref()`'d so it doesn't itself keep the process alive) forces exit if
this sequence hangs, rather than leaving a container stuck in a slow
death waiting on an orchestrator's kill timeout.

## Consequences

A delivery that's actively `processing` when `SIGTERM` arrives is
allowed to finish and reach `succeeded`/`failed`/`dead_lettered` before
the process exits — graceful shutdown doesn't lose it. A delivery that
was merely *queued* (not yet picked up) is simply left in the queue;
BullMQ's job persistence in Redis means the next worker process to
start picks it up with its attempt count intact, satisfying "finish or
get requeued cleanly" without hookguard having to implement any of that
requeue logic itself. The ordering is a manual, hand-maintained sequence
rather than something enforced by a framework — worth revisiting only if
more shutdown-sensitive resources get added later.
