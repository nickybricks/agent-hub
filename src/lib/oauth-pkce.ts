import { createHash, randomBytes } from "crypto";
import { cookies } from "next/headers";
import type { NextResponse } from "next/server";

export const OAUTH_PKCE_COOKIE = "oauth_pkce";
const COOKIE_MAX_AGE_SECONDS = 600;

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface PkcePair {
  state: string;
  codeVerifier: string;
  codeChallenge: string;
}

export function createPkcePair(): PkcePair {
  const state = base64url(randomBytes(32));
  const codeVerifier = base64url(randomBytes(64));
  const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest());
  return { state, codeVerifier, codeChallenge };
}

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: COOKIE_MAX_AGE_SECONDS,
} as const;

export function attachPkceCookie(response: NextResponse, state: string, codeVerifier: string): void {
  response.cookies.set(OAUTH_PKCE_COOKIE, JSON.stringify({ state, codeVerifier }), COOKIE_OPTIONS);
}

export async function readPkceCookie(): Promise<{ state: string; codeVerifier: string } | null> {
  const jar = await cookies();
  const raw = jar.get(OAUTH_PKCE_COOKIE)?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { state?: unknown; codeVerifier?: unknown };
    if (typeof parsed.state !== "string" || typeof parsed.codeVerifier !== "string") return null;
    return { state: parsed.state, codeVerifier: parsed.codeVerifier };
  } catch {
    return null;
  }
}

export function clearPkceCookie(response: NextResponse): void {
  response.cookies.delete(OAUTH_PKCE_COOKIE);
}
