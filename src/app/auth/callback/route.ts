import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";

/**
 * Auth callback for BOTH Supabase email flows:
 *  - PKCE:        ?code=...                 → exchangeCodeForSession
 *  - token-hash:  ?token_hash=...&type=...  → verifyOtp  (magic links,
 *                 incl. admin-generated links — these never carry ?code)
 *
 * Critical: the session cookies must be written onto the SAME response object
 * we return. The shared server client sets cookies via next/headers, which are
 * NOT attached to a custom NextResponse.redirect() — so the session was lost on
 * redirect and every authenticated request 401'd.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = searchParams.get("next") ?? "/app";

  const cookieStore = await cookies();
  const success = NextResponse.redirect(`${origin}${next}`);

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            success.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return success;
  } else if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) return success;
  }

  return NextResponse.redirect(`${origin}/login?error=auth`);
}
