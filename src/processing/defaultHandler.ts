import type { Delivery } from "../db/deliveries.js";
import type { DeliveryProcessor } from "../queue/worker.js";

/**
 * Placeholder business logic. hookguard's job is reliable delivery, not
 * what happens with the payload once it arrives — swap this for whatever
 * downstream action a real integration needs (call an internal API,
 * write to another system, etc).
 */
export const defaultProcessor: DeliveryProcessor = async (
  _delivery: Delivery,
): Promise<void> => {
  // No-op: acknowledge receipt. Replace with real processing.
};
