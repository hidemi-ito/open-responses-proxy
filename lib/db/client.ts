import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// Lazy singleton — DB client is only created on first use.
// This allows the server to start without DATABASE_URL when store=false.
let _db: ReturnType<typeof drizzle> | undefined;

export function getDb(): ReturnType<typeof drizzle> {
  if (_db) return _db;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL environment variable is not set. " +
      "Required when using previous_response_id or store=true.",
    );
  }
  const sql = postgres(connectionString);
  _db = drizzle(sql, { schema });
  return _db;
}

// Convenience proxy — existing code using `db.select()` etc. continues to work.
export const db = new Proxy({} as ReturnType<typeof drizzle>, {
  get(_target, prop) {
    return (getDb() as unknown as Record<string | symbol, unknown>)[prop];
  },
});
