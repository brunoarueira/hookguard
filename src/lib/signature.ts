import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_PREFIX = "sha256=";

/**
 * Verifies an HMAC-SHA256 webhook signature against the raw request body.
 * Uses a constant-time comparison to avoid leaking timing information
 * about how much of the signature matched.
 */
export function verifySignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;

  const provided = signatureHeader.startsWith(SIGNATURE_PREFIX)
    ? signatureHeader.slice(SIGNATURE_PREFIX.length)
    : signatureHeader;

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");

  const providedBuf = Buffer.from(provided, "hex");
  const expectedBuf = Buffer.from(expected, "hex");

  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}
