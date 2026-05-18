import { Inngest } from "inngest";

// Set the mode explicitly. The SDK's auto-detection wrongly stayed in Dev mode
// on Vercel, so `inngest.send()` targeted the local dev server (localhost:8288)
// in production → ECONNREFUSED. Convention (see .env.local): INNGEST_DEV=1
// locally, unset everywhere else → cloud (uses INNGEST_EVENT_KEY).
export const inngest = new Inngest({
  id: "mail-workflow",
  isDev: process.env.INNGEST_DEV === "1",
});
