# 1. Record architecture decisions

## Status

Accepted

## Context

hookguard exists to demonstrate real backend/API/DB depth, not just to
ship a working service — the reasoning behind each design choice (why
this idempotency-key approach, why this retry strategy) is as much the
point as the code. That reasoning needs a durable home that survives
past the README's "short, not a thesis" scope and past whatever gets
said out loud in an interview.

## Decision

Record architecture decisions as ADRs under `docs/adr/`, one file per
decision, numbered sequentially (`NNNN-kebab-case-title.md`), following
the standard Nygard format: Status, Context, Decision, Consequences.
A decision gets an ADR when it has real alternatives that were
rejected for a reason worth remembering — not for every line of code.

## Consequences

Anyone reading the code later (including future-me) can trace *why* a
piece of it looks the way it does without relying on memory or a git
archaeology session. The README can stay short and point here for
detail instead of re-explaining every tradeoff inline.
