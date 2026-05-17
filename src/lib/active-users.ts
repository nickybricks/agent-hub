import { getDrizzleDb } from "@/lib/db";
import { userSettings } from "../../db/schema";

/**
 * Active users for scheduled jobs = everyone who has configured mail
 * (one row per user in user_settings; userId is unique).
 */
export async function listActiveUserIds(): Promise<string[]> {
  const rows = await getDrizzleDb()
    .select({ userId: userSettings.userId })
    .from(userSettings);
  return rows.map((r) => r.userId);
}
