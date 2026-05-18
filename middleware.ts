import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Refresh session if expired, and capture the user for the gate below.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Auth gate (multi-tenant only): the product pages need a session. Without
  // this an unauthenticated visitor lands on /app and every API call silently
  // 401s, which looks broken. Send them to /login instead. API routes keep
  // returning their own 401 (a redirect would break fetch); the page redirect
  // is what gets the user signed in.
  const path = request.nextUrl.pathname;
  const isProtectedPage =
    path === "/app" || path.startsWith("/app/") || path.startsWith("/onboarding");
  if (process.env.MULTI_TENANT === "true" && !user && isProtectedPage) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
