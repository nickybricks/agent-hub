import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../db/schema";

let _pg: ReturnType<typeof postgres> | null = null;
let _drizzle: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDrizzleDb() {
  if (!_drizzle) {
    _pg = postgres(process.env.DATABASE_URL!);
    _drizzle = drizzle(_pg, { schema });
  }
  return _drizzle;
}

export function isMultiTenant(): boolean {
  return process.env.MULTI_TENANT === "true";
}
