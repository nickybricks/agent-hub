import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRateLimit } from "../rate-limit";

test("rate-limit — allows up to limit then 429s", async () => {
  const key = `t1:${Math.random()}`;
  for (let i = 0; i < 10; i++) {
    assert.equal((await checkRateLimit(key, 10, 60)).ok, true, `request ${i + 1} should pass`);
  }
  const blocked = await checkRateLimit(key, 10, 60);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterSeconds > 0, "Retry-After should be positive");
});

test("rate-limit — separate keys do not share budget", async () => {
  const a = `t2a:${Math.random()}`;
  const b = `t2b:${Math.random()}`;
  for (let i = 0; i < 10; i++) await checkRateLimit(a, 10, 60);
  assert.equal((await checkRateLimit(a, 10, 60)).ok, false);
  assert.equal((await checkRateLimit(b, 10, 60)).ok, true);
});

test("rate-limit — refills proportionally over time", async () => {
  const key = `t3:${Math.random()}`;
  // Drain
  for (let i = 0; i < 5; i++) assert.equal((await checkRateLimit(key, 5, 1)).ok, true);
  assert.equal((await checkRateLimit(key, 5, 1)).ok, false);
  // Wait ~250ms → expect ~1 token back at rate 5/sec
  await new Promise((r) => setTimeout(r, 250));
  assert.equal((await checkRateLimit(key, 5, 1)).ok, true);
});
