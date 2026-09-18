import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { insertReceived, getById } from "../src/db/deliveries.js";
import { closeTestPool, getTestPool, truncateAll } from "./helpers/db.js";

describe("insertReceived (idempotency)", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it("creates a new row for a first-time delivery", async () => {
    const pool = await getTestPool();
    const deliveryId = randomUUID();

    const result = await insertReceived(pool, {
      source: "github",
      deliveryId,
      payload: { hello: "world" },
      headers: {},
    });

    expect(result.created).toBe(true);
    expect(result.delivery.status).toBe("received");

    const fetched = await getById(pool, result.delivery.id);
    expect(fetched?.deliveryId).toBe(deliveryId);
  });

  it("does not create a second row for a retried delivery id", async () => {
    const pool = await getTestPool();
    const deliveryId = randomUUID();

    const first = await insertReceived(pool, {
      source: "github",
      deliveryId,
      payload: { attempt: 1 },
      headers: {},
    });
    const second = await insertReceived(pool, {
      source: "github",
      deliveryId,
      payload: { attempt: 2 }, // sender resends the same delivery id
      headers: {},
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.delivery.id).toBe(first.delivery.id);

    const count = await pool.query(
      "SELECT count(*)::int AS n FROM deliveries WHERE delivery_id = $1",
      [deliveryId],
    );
    expect(count.rows[0]?.n).toBe(1);
  });

  it("treats the same delivery id from different sources as distinct", async () => {
    const pool = await getTestPool();
    const deliveryId = randomUUID();

    const fromGithub = await insertReceived(pool, {
      source: "github",
      deliveryId,
      payload: {},
      headers: {},
    });
    const fromStripe = await insertReceived(pool, {
      source: "stripe",
      deliveryId,
      payload: {},
      headers: {},
    });

    expect(fromGithub.created).toBe(true);
    expect(fromStripe.created).toBe(true);
    expect(fromGithub.delivery.id).not.toBe(fromStripe.delivery.id);
  });
});
