"use client";

import { motion } from "framer-motion";

// Placeholder visual until the Higgs Field render lands at /landing/declutter.mp4.
// Renders a stylized mail UI: chaotic rows fly into 5 brand-tinted folders on
// the right, then settle into an "Inbox Zero" calm state. Loops forever.

const folders = [
  { tone: "oklch(0.33 0.14 358)", x: 280, y: 30, label: "Work" },
  { tone: "oklch(0.45 0.12 158)", x: 290, y: 78, label: "Bills" },
  { tone: "oklch(0.55 0.025 265)", x: 285, y: 126, label: "News" },
  { tone: "oklch(0.33 0.14 358 / 70%)", x: 295, y: 174, label: "Travel" },
  { tone: "oklch(0.45 0.12 158 / 70%)", x: 290, y: 222, label: "Personal" },
];

const rows = Array.from({ length: 8 }).map((_, i) => ({
  id: i,
  y: 36 + i * 22,
  targetFolder: i % 5,
  width: 130 + ((i * 17) % 50),
  delay: 0.4 + i * 0.18,
}));

export function DeclutterPreview() {
  return (
    <div className="relative w-full overflow-hidden rounded-[1.5rem] border border-[oklch(0.93_0.01_270)] bg-white shadow-[0_4px_32px_oklch(0.15_0.04_265/8%),0_1px_4px_oklch(0.15_0.04_265/6%)]">
      <svg
        viewBox="0 0 440 280"
        className="block h-auto w-full"
        role="img"
        aria-label="Animation: a cluttered inbox sorts itself into five tidy folders."
      >
        <defs>
          <linearGradient id="bg-wash" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="oklch(0.99 0.01 358 / 40%)" />
            <stop offset="100%" stopColor="oklch(0.97 0.02 158 / 40%)" />
          </linearGradient>
        </defs>

        <rect width="440" height="280" fill="url(#bg-wash)" />

        {/* Inbox panel */}
        <rect x="16" y="16" width="240" height="248" rx="14" fill="white" stroke="oklch(0.93 0.01 270)" />
        <text x="32" y="32" fontFamily="Plus Jakarta Sans" fontSize="10" fontWeight="700" fill="oklch(0.18 0.04 265)" letterSpacing="1.5">
          INBOX
        </text>

        {/* Folder stack on the right */}
        {folders.map((f, i) => (
          <g key={i}>
            <motion.rect
              x={f.x}
              y={f.y}
              width={130}
              height={36}
              rx={10}
              fill="white"
              stroke={f.tone}
              strokeWidth={1.2}
              initial={{ opacity: 0, x: f.x + 12 }}
              animate={{ opacity: 1, x: f.x }}
              transition={{ duration: 0.5, delay: 0.1 + i * 0.08, ease: "easeOut" }}
            />
            <motion.circle
              cx={f.x + 14}
              cy={f.y + 18}
              r={5}
              fill={f.tone}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.5, delay: 0.2 + i * 0.08 }}
            />
            <motion.text
              x={f.x + 26}
              y={f.y + 22}
              fontFamily="Plus Jakarta Sans"
              fontSize="11"
              fontWeight="600"
              fill="oklch(0.18 0.04 265)"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.5, delay: 0.25 + i * 0.08 }}
            >
              {f.label}
            </motion.text>
          </g>
        ))}

        {/* Email rows — fly from inbox to assigned folder */}
        {rows.map((row) => {
          const f = folders[row.targetFolder];
          return (
            <motion.g
              key={row.id}
              initial={{ opacity: 0, x: 0, y: 0 }}
              animate={{
                opacity: [0, 1, 1, 1, 0],
                x: [0, 0, 0, f.x - 36, f.x - 36],
                y: [0, 0, 0, f.y - row.y - 4, f.y - row.y - 4],
              }}
              transition={{
                duration: 6,
                times: [0, 0.05, 0.45, 0.75, 0.85],
                delay: row.delay,
                repeat: Infinity,
                repeatDelay: 1.2,
                ease: "easeInOut",
              }}
            >
              <rect
                x={32}
                y={row.y}
                width={208}
                height={16}
                rx={4}
                fill="oklch(0.97 0.005 270)"
              />
              <circle cx={42} cy={row.y + 8} r={4} fill={f.tone} />
              <rect x={52} y={row.y + 4} width={row.width} height={3} rx={1.5} fill="oklch(0.55 0.025 265)" />
              <rect x={52} y={row.y + 10} width={row.width - 30} height={2.5} rx={1.25} fill="oklch(0.78 0.015 270)" />
            </motion.g>
          );
        })}

        {/* "Inbox Zero" calm state — fades in after the rows clear */}
        <motion.g
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 0, 0, 0, 1, 1, 0] }}
          transition={{
            duration: 7.2,
            times: [0, 0.5, 0.7, 0.78, 0.82, 0.95, 1],
            delay: 0.4,
            repeat: Infinity,
            repeatDelay: 1.2,
            ease: "easeInOut",
          }}
        >
          <text
            x={136}
            y={144}
            textAnchor="middle"
            fontFamily="Plus Jakarta Sans"
            fontSize="14"
            fontWeight="700"
            fill="oklch(0.33 0.14 358)"
            letterSpacing="-0.01em"
          >
            Inbox Zero.
          </text>
          <text
            x={136}
            y={162}
            textAnchor="middle"
            fontFamily="Plus Jakarta Sans"
            fontSize="9"
            fontWeight="500"
            fill="oklch(0.55 0.025 265)"
            letterSpacing="0.05em"
          >
            and it stays that way
          </text>
        </motion.g>
      </svg>
    </div>
  );
}
