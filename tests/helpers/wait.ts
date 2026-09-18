import type { Pool } from "pg";
import { getById, type DeliveryStatus } from "../../src/db/deliveries.js";

export async function waitForStatus(
  pool: Pool,
  id: string,
  statuses: DeliveryStatus[],
  timeoutMs = 10_000,
): Promise<DeliveryStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const delivery = await getById(pool, id);
    if (delivery && statuses.includes(delivery.status)) {
      return delivery.status;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for delivery ${id} to reach one of [${statuses.join(", ")}], last seen: ${delivery?.status}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
