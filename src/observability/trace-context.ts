import { randomBytes } from "node:crypto";

const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

export interface RequestTraceContext {
  traceId: string;
  spanId: string;
  traceFlags: string;
  traceparent: string;
}

export function createRequestTraceContext(
  incomingTraceparent?: string,
): RequestTraceContext {
  const match = incomingTraceparent?.match(TRACEPARENT_PATTERN);
  const traceId = match?.[1] ?? randomBytes(16).toString("hex");
  const traceFlags = match?.[3] ?? "01";
  const spanId = randomBytes(8).toString("hex");
  return {
    traceId,
    spanId,
    traceFlags,
    traceparent: `00-${traceId}-${spanId}-${traceFlags}`,
  };
}
