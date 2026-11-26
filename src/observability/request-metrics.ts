export interface RequestMetric {
  method: string;
  route: string;
  status: number;
  count: number;
  totalDurationMs: number;
  maxDurationMs: number;
}

const requestMetrics = new Map<string, RequestMetric>();

export function recordRequestMetric(
  method: string,
  route: string,
  status: number,
  durationMs: number,
): void {
  const key = `${method} ${route} ${status}`;
  const existing = requestMetrics.get(key);
  if (existing) {
    existing.count += 1;
    existing.totalDurationMs += durationMs;
    existing.maxDurationMs = Math.max(existing.maxDurationMs, durationMs);
    return;
  }

  requestMetrics.set(key, {
    method,
    route,
    status,
    count: 1,
    totalDurationMs: durationMs,
    maxDurationMs: durationMs,
  });
}

export function snapshotRequestMetrics(): RequestMetric[] {
  return [...requestMetrics.values()].map((metric) => ({ ...metric }));
}
