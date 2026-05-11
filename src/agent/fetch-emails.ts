import { execSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { traceable } from "langsmith/traceable";
import { Email } from "../lib/types";

// MIME quoted-printable decoder. Newsletter HTML is usually QP-encoded in the
// raw `source of msg`, which is why naive href="..." matching misses URLs
// (they appear as href=3D"...=\n...").
function decodeQuotedPrintable(s: string): string {
  return s
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

const SKIP_URL = /unsubscribe|optout|opt-out|mailto:|click\.mlsend|track\.|open\.|pixel\.|beacon\.|twitter\.com\/intent|facebook\.com\/sharer|linkedin\.com\/share|plus\.google/i;

function extractLinksFromHtml(html: string): { text: string; url: string }[] {
  const seen = new Set<string>();
  const results: { text: string; url: string }[] = [];
  const re = /<a\b[^>]*?href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const url = decodeHtmlEntities(m[1]);
    if (SKIP_URL.test(url)) continue;
    const text = decodeHtmlEntities(m[2].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    if (!text) continue;
    const key = `${text}|${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ text, url });
    if (results.length >= 50) break;
  }
  return results;
}

function extractImagesFromHtml(html: string): { id: string; url: string; alt: string }[] {
  const seen = new Set<string>();
  const results: { id: string; url: string; alt: string }[] = [];
  const re = /<img\b[^>]*?>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const srcM = /\bsrc=["'](https?:\/\/[^"']+)["']/i.exec(tag);
    if (!srcM) continue;
    const url = decodeHtmlEntities(srcM[1]);
    // Skip 1x1 trackers and common tracking pixel hosts
    if (SKIP_URL.test(url)) continue;
    if (/width=["']?1["']?/i.test(tag) && /height=["']?1["']?/i.test(tag)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const altM = /\balt=["']([^"']*)["']/i.exec(tag);
    const alt = altM ? decodeHtmlEntities(altM[1]).trim() : "";
    results.push({ id: `IMAGE_${results.length + 1}`, url, alt });
    if (results.length >= 30) break;
  }
  return results;
}

// Apple Mail replaces inline images in `content of msg` with U+FFFC (￼).
// Swap those for [IMAGE_N] markers so the LLM can position images in output.
function annotateImageMarkers(body: string, imageCount: number): string {
  let i = 0;
  return body.replace(/￼/g, () => {
    i += 1;
    return i <= imageCount ? `[IMAGE_${i}]` : "";
  });
}

function escapeForAppleScript(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function _fetchNewsletterEmails(
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
    tell application "Mail"
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

                  -- Fetch raw HTML source for link extraction (truncated to keep memory safe)
                  set msgSource to ""
                  try
                    set msgSource to source of msg
                    if length of msgSource > 100000 then
                      set msgSource to text 1 thru 100000 of msgSource
                    end if
                  end try

                  set end of matchingMessages to "---EMAIL_START---" & ¬
                    "ID:" & msgId & ¬
                    "---FIELD---" & "SUBJECT:" & msgSubject & ¬
                    "---FIELD---" & "SENDER:" & senderName & ¬
                    "---FIELD---" & "SENDER_EMAIL:" & senderAddr & ¬
                    "---FIELD---" & "DATE:" & msgDate & ¬
                    "---FIELD---" & "READ:" & (msgRead as string) & ¬
                    "---FIELD---" & "BODY:" & msgContent & ¬
                    "---FIELD---" & "SOURCE:" & msgSource & ¬
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

      const rawSource = getField("SOURCE:");
      const html = decodeQuotedPrintable(rawSource);
      const images = extractImagesFromHtml(html);
      const body = annotateImageMarkers(getField("BODY:"), images.length);
      emails.push({
        id: getField("ID:"),
        subject: getField("SUBJECT:"),
        sender: getField("SENDER:"),
        senderEmail: getField("SENDER_EMAIL:"),
        date: getField("DATE:"),
        body,
        links: extractLinksFromHtml(html),
        images,
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

export const fetchNewsletterEmails = traceable(_fetchNewsletterEmails, {
  name: "fetch-newsletter-emails",
  run_type: "tool",
});
