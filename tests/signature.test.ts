import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySignature } from "../src/lib/signature.js";

const SECRET = "test-secret";

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

describe("verifySignature", () => {
  it("accepts a correctly signed body", () => {
    const body = Buffer.from(JSON.stringify({ hello: "world" }));
    const header = sign(body.toString());
    expect(verifySignature(body, header, SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const original = Buffer.from(JSON.stringify({ hello: "world" }));
    const header = sign(original.toString());
    const tampered = Buffer.from(JSON.stringify({ hello: "mallory" }));
    expect(verifySignature(tampered, header, SECRET)).toBe(false);
  });

  it("rejects a signature made with the wrong secret", () => {
    const body = Buffer.from(JSON.stringify({ hello: "world" }));
    const header = `sha256=${createHmac("sha256", "wrong-secret").update(body).digest("hex")}`;
    expect(verifySignature(body, header, SECRET)).toBe(false);
  });

  it("rejects a missing signature header", () => {
    const body = Buffer.from(JSON.stringify({ hello: "world" }));
    expect(verifySignature(body, undefined, SECRET)).toBe(false);
  });

  it("accepts a raw hex signature without the sha256= prefix", () => {
    const body = Buffer.from(JSON.stringify({ hello: "world" }));
    const raw = createHmac("sha256", SECRET).update(body).digest("hex");
    expect(verifySignature(body, raw, SECRET)).toBe(true);
  });
});
