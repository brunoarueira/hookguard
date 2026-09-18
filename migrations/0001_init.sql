CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE delivery_status AS ENUM (
  'received',
  'processing',
  'succeeded',
  'failed',
  'dead_lettered'
);

-- One row per inbound webhook delivery, deduped on (source, delivery_id).
-- This is what makes retried deliveries from the sender idempotent: a
-- second POST with the same delivery_id is a no-op insert, not a new job.
CREATE TABLE deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  status delivery_status NOT NULL DEFAULT 'received',
  payload JSONB NOT NULL,
  headers JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, delivery_id)
);

-- Append-only audit trail of every state transition, so any delivery's
-- history can be reconstructed independent of log retention.
CREATE TABLE delivery_events (
  id BIGSERIAL PRIMARY KEY,
  delivery_id UUID NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_delivery_events_delivery_id ON delivery_events (delivery_id);
CREATE INDEX idx_deliveries_status ON deliveries (status);
