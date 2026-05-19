/**
 * Current-user resolution, dual-path.
 *  - multi-tenant: the Supabase auth session (id + login email).
 *  - local SQLite dev: a fixed single user; primary email is unknown to the
 *    app (it lives in the IMAP/OAuth config, not an account system).
 */
import { isMultiTenant } from "./db";
import { createClient } from "./supabase/server";

/** Fixed tenant id for the local SQLite path (no auth user there). */
const LOCAL_USER = "local";

export interface AuthUser {
  userId: string;
  /** Login / primary email — null in local single-user mode. */
  email: string | null;
}

/** Returns the current user, or null if multi-tenant and not signed in. */
export async function getAuthUser(): Promise<AuthUser | null> {
  if (!isMultiTenant()) return { userId: LOCAL_USER, email: null };
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) return null;
  return { userId: user.id, email: user.email ?? null };
}
