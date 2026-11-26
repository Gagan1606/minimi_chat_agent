import { Pool, type PoolConfig } from "pg";

export function createPool(
  connectionString: string,
  options: Omit<PoolConfig, "connectionString"> = {},
): Pool {
  if (!connectionString.trim()) {
    throw new Error("A PostgreSQL connection string is required");
  }

  return new Pool({
    connectionString,
    max: 20,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
    ...options,
  });
}
