import { execSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { traceable } from "langsmith/traceable";
import { Summary } from "../lib/types";

function _sendDigestEmail(summary: Summary, to: string): boolean {
  if (!to) {
    console.log("No email recipient configured. Skipping email delivery.");
    return false;
  }

  // Convert markdown to plain text for email (basic conversion)
  const plainText = summary.content
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/---/g, "────────────────────");

  const subject = `📰 ${summary.title}`;
  const body = `${plainText}

────────────────────
Generated from ${summary.emailCount} newsletter(s) on ${new Date().toLocaleDateString()}
Sources: ${summary.sources.map((s) => s.sender).join(", ")}`;

  const escapedSubject = subject.replace(/"/g, '\\"');
  const escapedBody = body.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const escapedTo = to.replace(/"/g, '\\"');

  const script = `
    tell application "Mail"
      set newMessage to make new outgoing message with properties {subject:"${escapedSubject}", content:"${escapedBody}", visible:false}
      tell newMessage
        make new to recipient at end of to recipients with properties {address:"${escapedTo}"}
      end tell
      send newMessage
    end tell
  `;

  const tmpFile = join(tmpdir(), `mail-send-${Date.now()}.scpt`);
  try {
    writeFileSync(tmpFile, script, "utf-8");
    execSync(`osascript "${tmpFile}"`, {
      timeout: 30000,
    });
    console.log(`Digest email sent to ${to}`);
    return true;
  } catch (error) {
    console.error("Error sending digest email:", error);
    return false;
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

export const sendDigestEmail = traceable(_sendDigestEmail, {
  name: "send-digest-email",
  run_type: "tool",
});
