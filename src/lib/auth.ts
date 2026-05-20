/**
 * Current-user resolution. Multi-tenant only (Supabase auth session).
 */
import { createClient } from "./supabase/server";

export interface AuthUser {
  userId: string;
  email: string | null;
}

/** Returns the current user, or null if not signed in. */
export async function getAuthUser(): Promise<AuthUser | null> {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) return null;
  return { userId: user.id, email: user.email ?? null };
}
