"use client";

import { motion } from "framer-motion";
import { WaitlistForm } from "./WaitlistForm";
import { DeclutterPreview } from "./DeclutterPreview";

const fadeUp = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0 },
};

export function Hero() {
  return (
    <main className="relative isolate min-h-screen overflow-hidden bg-[oklch(0.992_0.002_270)] text-[oklch(0.18_0.04_265)]">
      {/* Ambient background blob */}
      <motion.div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 1.2, ease: "easeOut" }}
      >
        <motion.div
          className="absolute left-[10%] top-[-10%] h-[520px] w-[520px] rounded-full blur-3xl"
          style={{
            background:
              "radial-gradient(circle, oklch(0.33 0.14 358 / 14%), transparent 70%)",
          }}
          animate={{ x: [0, 40, 0], y: [0, 30, 0] }}
          transition={{ duration: 22, repeat: Infinity, ease: "easeInOut" }}
        />
        <motion.div
          className="absolute right-[5%] bottom-[-15%] h-[600px] w-[600px] rounded-full blur-3xl"
          style={{
            background:
              "radial-gradient(circle, oklch(0.45 0.12 158 / 12%), transparent 70%)",
          }}
          animate={{ x: [0, -40, 0], y: [0, -20, 0] }}
          transition={{ duration: 26, repeat: Infinity, ease: "easeInOut" }}
        />
      </motion.div>

      {/* Top mark */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
        className="absolute left-1/2 top-5 -translate-x-1/2 whitespace-nowrap text-xs font-bold tracking-tight text-[oklch(0.18_0.04_265)] sm:top-8 sm:text-sm"
      >
        Mi <span className="text-[oklch(0.55_0.025_265)] font-medium">— Mail Intelligence</span>
      </motion.div>

      <div className="mx-auto flex min-h-screen max-w-[1100px] flex-col items-center justify-center px-5 pb-16 pt-20 sm:px-10 sm:pt-24 sm:pb-24">
        <motion.div
          initial="hidden"
          animate="show"
          variants={{
            show: { transition: { staggerChildren: 0.09, delayChildren: 0.15 } },
          }}
          className="flex w-full flex-col items-center text-center"
        >
          {/* Status pill */}
          <motion.div
            variants={fadeUp}
            transition={{ duration: 0.5, ease: "easeOut" }}
            className="mb-10 inline-flex items-center gap-2 rounded-full bg-[oklch(0.95_0.03_358)] px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-[oklch(0.33_0.14_358)]"
          >
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[oklch(0.45_0.12_158)] opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-[oklch(0.45_0.12_158)]" />
            </span>
            <span>Currently in build</span>
          </motion.div>

          {/* Wordmark */}
          <motion.h1
            variants={fadeUp}
            transition={{ duration: 0.7, ease: "easeOut" }}
            className="font-extrabold leading-[1.02] tracking-[-0.03em]"
            style={{
              fontSize: "clamp(56px, 11vw, 128px)",
            }}
          >
            <span
              className="block bg-clip-text text-transparent"
              style={{
                backgroundImage:
                  "linear-gradient(135deg, oklch(0.33 0.14 358) 0%, oklch(0.45 0.12 158) 100%)",
              }}
            >
              Mi
            </span>
            <span
              className="mt-1 block text-[oklch(0.18_0.04_265)]"
              style={{ fontSize: "clamp(28px, 4.4vw, 52px)", letterSpacing: "-0.02em" }}
            >
              Mail Intelligence.
            </span>
          </motion.h1>

          {/* Problem + solution */}
          <motion.p
            variants={fadeUp}
            transition={{ duration: 0.5, ease: "easeOut" }}
            className="mt-6 max-w-[640px] text-[17px] leading-[1.55] text-[oklch(0.35_0.03_265)] sm:mt-8 sm:text-[21px]"
          >
            Your inbox drowns in newsletters, receipts, and noise.
            <br className="hidden sm:block" />
            <span className="text-[oklch(0.18_0.04_265)] font-medium">
              Mi sorts it once — and keeps it that way.
            </span>
          </motion.p>

          {/* Subline */}
          <motion.p
            variants={fadeUp}
            transition={{ duration: 0.5, ease: "easeOut" }}
            className="mt-3 max-w-[560px] text-[15px] leading-relaxed text-[oklch(0.55_0.025_265)]"
          >
            An AI that reads your mailbox, learns what matters, and quietly builds
            the folder structure you wish you had.
          </motion.p>

          {/* Waitlist form */}
          <motion.div
            variants={fadeUp}
            transition={{ duration: 0.5, ease: "easeOut" }}
            className="mt-10 flex w-full justify-center"
          >
            <WaitlistForm />
          </motion.div>

          {/* Visual */}
          <motion.div
            variants={fadeUp}
            transition={{ duration: 0.6, ease: "easeOut" }}
            className="mt-12 w-full max-w-[760px] sm:mt-16"
          >
            <DeclutterPreview />
          </motion.div>

          {/* Signature */}
          <motion.p
            variants={fadeUp}
            transition={{ duration: 0.5, ease: "easeOut" }}
            className="mt-12 text-xs tracking-wide text-[oklch(0.55_0.025_265)]"
          >
            built with care in Berlin · nick@algner.de
          </motion.p>
        </motion.div>
      </div>
    </main>
  );
}
