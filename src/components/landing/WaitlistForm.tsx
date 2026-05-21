"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

type Status = "idle" | "submitting" | "success" | "duplicate" | "error";

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState(""); // honeypot
  const [status, setStatus] = useState<Status>("idle");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (status === "submitting" || status === "success") return;
    if (!emailRegex.test(email.trim())) {
      setStatus("error");
      return;
    }
    setStatus("submitting");
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          company,
          referrer: typeof document !== "undefined" ? document.referrer : undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        setStatus("success");
      } else if (res.status === 409 || data.reason === "duplicate") {
        setStatus("duplicate");
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    }
  }

  return (
    <div className="w-full max-w-md">
      <AnimatePresence mode="wait">
        {status === "success" || status === "duplicate" ? (
          <motion.div
            key="done"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className="flex items-center gap-3 rounded-full bg-[oklch(0.95_0.03_158)] px-5 py-4 text-[oklch(0.35_0.12_158)]"
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[oklch(0.45_0.12_158)] text-white">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
                <path
                  d="M3 7.5L5.5 10L11 4"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span className="text-sm font-medium">
              {status === "success"
                ? "You're in. We'll write when Mi opens up."
                : "You're already on the list."}
            </span>
          </motion.div>
        ) : (
          <motion.form
            key="form"
            onSubmit={onSubmit}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className="flex w-full flex-col gap-2 sm:flex-row"
            noValidate
          >
            <label htmlFor="waitlist-email" className="sr-only">
              Email address
            </label>
            <input
              id="waitlist-email"
              type="email"
              autoComplete="email"
              required
              placeholder="you@work.com"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (status === "error") setStatus("idle");
              }}
              disabled={status === "submitting"}
              className="block h-14 w-full flex-1 appearance-none rounded-full border border-[oklch(0.88_0.01_270)] bg-white px-6 text-[16px] leading-none text-[oklch(0.18_0.04_265)] shadow-[0_1px_2px_oklch(0.15_0.04_265/4%)] placeholder:text-[oklch(0.55_0.025_265)] outline-none transition focus:border-[oklch(0.33_0.14_358)] focus:ring-4 focus:ring-[oklch(0.33_0.14_358/15%)] disabled:opacity-60 sm:h-12 sm:text-[15px]"
            />
            <input
              type="text"
              name="company"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              tabIndex={-1}
              autoComplete="off"
              aria-hidden
              className="hidden"
            />
            <motion.button
              type="submit"
              disabled={status === "submitting"}
              whileHover={{ scale: status === "submitting" ? 1 : 1.02 }}
              whileTap={{ scale: status === "submitting" ? 1 : 0.97 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
              className="group inline-flex h-14 w-full items-center justify-center gap-2 rounded-full bg-[oklch(0.33_0.14_358)] px-7 text-[16px] font-semibold text-white shadow-[0_2px_12px_oklch(0.33_0.14_358/25%)] transition hover:bg-[oklch(0.28_0.13_358)] hover:shadow-[0_6px_24px_oklch(0.33_0.14_358/35%)] disabled:opacity-70 sm:h-12 sm:w-auto sm:text-[15px]"
            >
              {status === "submitting" ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                  <span>Joining…</span>
                </>
              ) : (
                <>
                  <span>Join the waitlist</span>
                  <span className="transition-transform group-hover:translate-x-0.5" aria-hidden>
                    →
                  </span>
                </>
              )}
            </motion.button>
          </motion.form>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {status === "error" && (
          <motion.p
            key="err"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mt-3 pl-2 text-sm text-[oklch(0.45_0.18_25)]"
          >
            Something went wrong. Please check the address and try again.
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}
