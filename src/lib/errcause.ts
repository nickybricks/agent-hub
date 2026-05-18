/**
 * Flatten an error + its .cause chain + AggregateError .errors[] into one
 * actionable string (code/syscall/address:port/message). DrizzleQueryError and
 * undici "fetch failed" both bury the real reason in .cause.
 */
export function describeError(err: unknown): string {
  const bits: string[] = [];
  const seen = new Set<unknown>();
  const visit = (e: unknown, depth = 0) => {
    if (!e || seen.has(e) || depth > 8) return;
    seen.add(e);
    const o = e as {
      message?: string; code?: string; syscall?: string; detail?: string;
      address?: string; port?: number; cause?: unknown; errors?: unknown[];
    };
    const loc = o.address ? ` ${o.address}${o.port ? ":" + o.port : ""}` : "";
    const head = `${o.code ?? ""}${o.syscall ? " " + o.syscall : ""}${loc}`.trim();
    if (head) bits.push(head);
    if (o.detail) bits.push(o.detail);
    else if (o.message) bits.push(o.message.split("\n")[0].slice(0, 200));
    if (Array.isArray(o.errors)) o.errors.forEach((x) => visit(x, depth + 1));
    visit(o.cause, depth + 1);
  };
  visit(err);
  return [...new Set(bits)].filter(Boolean).join(" | ") || "unknown error";
}
