# 4. Capture the raw request body for signature verification before JSON parsing

## Status

Accepted

## Context

Webhook signature verification (HMAC-SHA256 over the request body,
compared against `x-webhook-signature`) must run over exactly the bytes
the sender signed. Fastify's default JSON body parser hands the route
handler a parsed JavaScript object, not the original bytes — and
`JSON.stringify(parsedBody)` is not guaranteed to reproduce the original
byte sequence (key order, whitespace, number formatting can all differ),
so re-serializing the parsed object to verify a signature is unreliable
in a way that would intermittently and unpredictably reject valid
deliveries.

## Decision

Replace Fastify's default `application/json` content-type parser with a
custom one (`app.addContentTypeParser` in `src/server.ts`) that reads
the body as a raw `Buffer`, stashes it on `request.rawBody`, and only
then parses it as JSON for the route handler to use. Signature
verification (`src/lib/signature.ts`) runs against `request.rawBody`,
never against a re-serialized copy.

## Consequences

Signature verification is correct by construction — it operates on the
actual bytes transmitted, so there's no class of "valid signature,
wrong bytes reconstructed" bug to chase. The cost is a small amount of
custom body-parsing code instead of relying on Fastify's default, and
every request body is held in memory twice, briefly, as both a Buffer
and its parsed form — acceptable at webhook payload sizes, and it would
need revisiting only if hookguard ever had to accept very large
payloads.
