import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../db/schema";

let _pg: ReturnType<typeof postgres> | null = null;
let _drizzle: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDrizzleDb() {
  if (!_drizzle) {
    // `prepare: false` is REQUIRED behind Supabase's transaction pooler
    // (pgbouncer) — prepared statements break there and every query errors on
    // Vercel while working locally against the direct connection. Harmless on a
    // direct connection. Serverless-friendly pool sizing too.
    _pg = postgres(process.env.DATABASE_URL!, {
      prepare: false,
      max: 1,
      idle_timeout: 20,
    });
    _drizzle = drizzle(_pg, { schema });
  }
  return _drizzle;
}

export function isMultiTenant(): boolean {
  return process.env.MULTI_TENANT === "true";
}
