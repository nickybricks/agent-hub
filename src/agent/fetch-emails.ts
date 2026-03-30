import { execSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Email } from "../lib/types";

function escapeForAppleScript(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function fetchNewsletterEmails(
  senders: string[],
  lookbackHours: number,
  maxEmails: number
): Email[] {
  if (senders.length === 0) {
    console.log("No senders configured. Skipping email fetch.");
    return [];
  }

  const senderConditions = senders
    .map((s) => `sender of msg contains "${escapeForAppleScript(s)}"`)
    .join(" or ");

  const script = `
    set mailWasRunning to application "Mail" is running
    tell application "Mail"
      activate
      if mailWasRunning then
        delay 3
      else
        delay 12
      end if
      check for new mail
      delay 3
      set cutoffDate to (current date) - (${lookbackHours} * 60 * 60)
      set matchingMessages to {}
      set msgCount to 0

      repeat with acct in accounts
        repeat with mb in mailboxes of acct
          try
            set msgs to (messages of mb whose date received > cutoffDate)
            repeat with msg in msgs
              if msgCount ≥ ${maxEmails} then exit repeat
              try
                if ${senderConditions} then
                  set senderName to sender of msg
                  set senderAddr to extract address from sender of msg
                  set msgSubject to subject of msg
                  set msgDate to date received of msg as string
                  set msgContent to content of msg
                  set msgId to message id of msg
                  set msgRead to read status of msg

                  -- Truncate very long emails
                  if length of msgContent > 10000 then
                    set msgContent to text 1 thru 10000 of msgContent
                  end if

                  set end of matchingMessages to "---EMAIL_START---" & ¬
                    "ID:" & msgId & ¬
                    "---FIELD---" & "SUBJECT:" & msgSubject & ¬
                    "---FIELD---" & "SENDER:" & senderName & ¬
                    "---FIELD---" & "SENDER_EMAIL:" & senderAddr & ¬
                    "---FIELD---" & "DATE:" & msgDate & ¬
                    "---FIELD---" & "READ:" & (msgRead as string) & ¬
                    "---FIELD---" & "BODY:" & msgContent & ¬
                    "---EMAIL_END---"
                  set msgCount to msgCount + 1
                end if
              end try
            end repeat
            if msgCount ≥ ${maxEmails} then exit repeat
          end try
        end repeat
        if msgCount ≥ ${maxEmails} then exit repeat
      end repeat

      set AppleScript's text item delimiters to "|||"
      return matchingMessages as string
    end tell
  `;

  const tmpFile = join(tmpdir(), `mail-fetch-${Date.now()}.scpt`);
  try {
    writeFileSync(tmpFile, script, "utf-8");
    const result = execSync(`osascript "${tmpFile}"`, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 120000,
    }).toString();

    if (!result.trim()) {
      return [];
    }

    const emailBlocks = result.split("|||");
    const emails: Email[] = [];

    for (const block of emailBlocks) {
      if (!block.includes("---EMAIL_START---")) continue;

      const content = block
        .replace("---EMAIL_START---", "")
        .replace("---EMAIL_END---", "");
      const fields = content.split("---FIELD---");

      const getField = (prefix: string): string => {
        const field = fields.find((f) => f.startsWith(prefix));
        return field ? field.slice(prefix.length).trim() : "";
      };

      emails.push({
        id: getField("ID:"),
        subject: getField("SUBJECT:"),
        sender: getField("SENDER:"),
        senderEmail: getField("SENDER_EMAIL:"),
        date: getField("DATE:"),
        body: getField("BODY:"),
        isRead: getField("READ:") === "true",
      });
    }

    return emails;
  } catch (error) {
    console.error("Error fetching emails from Apple Mail:", error);
    return [];
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}
