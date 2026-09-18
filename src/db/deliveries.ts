import type { Pool, PoolClient } from "pg";

export type DeliveryStatus =
  | "received"
  | "processing"
  | "succeeded"
  | "failed"
  | "dead_lettered";

export interface Delivery {
  id: string;
  source: string;
  deliveryId: string;
  status: DeliveryStatus;
  payload: unknown;
  headers: Record<string, unknown>;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface DeliveryRow {
  id: string;
  source: string;
  delivery_id: string;
  status: DeliveryStatus;
  payload: unknown;
  headers: Record<string, unknown>;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

function fromRow(row: DeliveryRow): Delivery {
  return {
    id: row.id,
    source: row.source,
    deliveryId: row.delivery_id,
    status: row.status,
    payload: row.payload,
    headers: row.headers,
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function recordEvent(
  db: Pool | PoolClient,
  deliveryId: string,
  eventType: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `INSERT INTO delivery_events (delivery_id, event_type, detail)
     VALUES ($1, $2, $3)`,
    [deliveryId, eventType, detail ? JSON.stringify(detail) : null],
  );
}

export interface InsertResult {
  delivery: Delivery;
  /** false when this (source, deliveryId) pair already existed. */
  created: boolean;
}

/**
 * Idempotent insert keyed on (source, deliveryId). A retried delivery from
 * the sender hits the UNIQUE constraint and returns the existing row
 * instead of creating a duplicate — the caller can tell the two cases
 * apart via `created` and must not re-enqueue on a duplicate.
 */
export async function insertReceived(
  pool: Pool,
  params: {
    source: string;
    deliveryId: string;
    payload: unknown;
    headers: Record<string, unknown>;
  },
): Promise<InsertResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const insert = await client.query<DeliveryRow>(
      `INSERT INTO deliveries (source, delivery_id, payload, headers)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (source, delivery_id) DO NOTHING
       RETURNING *`,
      [
        params.source,
        params.deliveryId,
        JSON.stringify(params.payload),
        JSON.stringify(params.headers),
      ],
    );

    if (insert.rows[0]) {
      await recordEvent(client, insert.rows[0].id, "received", {
        source: params.source,
      });
      await client.query("COMMIT");
      return { delivery: fromRow(insert.rows[0]), created: true };
    }

    const existing = await client.query<DeliveryRow>(
      `SELECT * FROM deliveries WHERE source = $1 AND delivery_id = $2`,
      [params.source, params.deliveryId],
    );
    await client.query("COMMIT");
    const row = existing.rows[0];
    if (!row) {
      throw new Error(
        "Delivery insert conflicted but no existing row was found",
      );
    }
    return { delivery: fromRow(row), created: false };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getById(
  pool: Pool,
  id: string,
): Promise<Delivery | null> {
  const result = await pool.query<DeliveryRow>(
    "SELECT * FROM deliveries WHERE id = $1",
    [id],
  );
  return result.rows[0] ? fromRow(result.rows[0]) : null;
}

export async function markProcessing(
  pool: Pool,
  id: string,
  attempt: number,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE deliveries
       SET status = 'processing', attempts = $2, updated_at = now()
       WHERE id = $1`,
      [id, attempt],
    );
    await recordEvent(client, id, "processing", { attempt });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function markSucceeded(pool: Pool, id: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE deliveries
       SET status = 'succeeded', last_error = NULL, updated_at = now()
       WHERE id = $1`,
      [id],
    );
    await recordEvent(client, id, "succeeded");
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Failed but eligible for another retry attempt (not yet dead-lettered). */
export async function markFailed(
  pool: Pool,
  id: string,
  error: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE deliveries
       SET status = 'failed', last_error = $2, updated_at = now()
       WHERE id = $1`,
      [id, error],
    );
    await recordEvent(client, id, "failed", { error });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function markDeadLettered(
  pool: Pool,
  id: string,
  error: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE deliveries
       SET status = 'dead_lettered', last_error = $2, updated_at = now()
       WHERE id = $1`,
      [id, error],
    );
    await recordEvent(client, id, "dead_lettered", { error });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
