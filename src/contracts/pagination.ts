import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const CursorPayloadSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    createdAt: z.string().datetime({ offset: true }),
    scopeFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export interface CursorPosition {
  id: string;
  createdAt: string;
}

export function encodeCursor(
  position: CursorPosition,
  scopeBinding: string,
  secret: string,
): string {
  assertSecret(secret);
  if (!scopeBinding) throw new Error("Cursor scope binding is required");
  const normalized = z
    .object({
      id: z.string().uuid(),
      createdAt: z.string().datetime({ offset: true }),
    })
    .strict()
    .parse(position);
  const payload = Buffer.from(
    JSON.stringify({
      version: 1,
      ...normalized,
      scopeFingerprint: fingerprint(scopeBinding, secret),
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

export function decodeCursor(
  cursor: string,
  scopeBinding: string,
  secret: string,
): CursorPosition {
  assertSecret(secret);
  if (!scopeBinding) throw new Error("Cursor scope binding is required");
  if (cursor.length > 2048) throw new Error("Cursor is too large");
  const parts = cursor.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("Cursor is malformed");
  }
  const [payload, signature] = parts as [string, string];
  const expectedSignature = createHmac("sha256", secret)
    .update(payload)
    .digest();
  const actualSignature = decodeBase64Url(signature);
  if (!constantTimeEqual(expectedSignature, actualSignature)) {
    throw new Error("Cursor signature is invalid");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(decodeBase64Url(payload).toString("utf8"));
  } catch {
    throw new Error("Cursor payload is invalid");
  }
  const parsed = CursorPayloadSchema.parse(decoded);
  const expectedScope = Buffer.from(fingerprint(scopeBinding, secret), "hex");
  const actualScope = Buffer.from(parsed.scopeFingerprint, "hex");
  if (!constantTimeEqual(expectedScope, actualScope)) {
    throw new Error("Cursor belongs to a different scope");
  }
  return { id: parsed.id, createdAt: parsed.createdAt };
}

function fingerprint(scopeBinding: string, secret: string): string {
  return createHmac("sha256", secret)
    .update("cursor-scope:")
    .update(scopeBinding)
    .digest("hex");
}

function assertSecret(secret: string): void {
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("Cursor signing secret must be at least 32 bytes");
  }
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Cursor encoding is invalid");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new Error("Cursor encoding is not canonical");
  }
  return decoded;
}

function constantTimeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}
