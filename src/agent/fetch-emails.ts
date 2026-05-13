import { simpleParser } from "mailparser";
import { traceable } from "langsmith/traceable";
import { Email } from "../lib/types";
import { createMailProvider } from "../lib/mail-provider";

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

// Insert [IMAGE_N] markers into plaintext so the LLM can position images.
// We anchor at paragraph breaks, evenly spaced through the body.
function insertImageMarkers(plain: string, imageCount: number): string {
  if (imageCount === 0 || !plain) return plain;
  const paragraphs = plain.split(/\n{2,}/);
  if (paragraphs.length <= 1) {
    return plain + "\n\n" + Array.from({ length: imageCount }, (_, i) => `[IMAGE_${i + 1}]`).join(" ");
  }
  const step = Math.max(1, Math.floor(paragraphs.length / (imageCount + 1)));
  for (let i = 0; i < imageCount; i++) {
    const idx = Math.min(paragraphs.length - 1, (i + 1) * step);
    paragraphs[idx] = `[IMAGE_${i + 1}]\n\n${paragraphs[idx]}`;
  }
  return paragraphs.join("\n\n");
}

// Patterns for mailboxes we skip when searching for newsletters.
const SKIP_MAILBOX = /\b(drafts?|entwürfe|trash|deleted|papierkorb|gelöscht|sent|gesendete?|outbox|postausgang)\b/i;

async function _fetchNewsletterEmails(
  senders: string[],
  lookbackHours: number,
  maxEmails: number
): Promise<Email[]> {
  if (senders.length === 0) {
    console.log("No senders configured. Skipping email fetch.");
    return [];
  }

  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
  const session = await createMailProvider();
  await session.open();

  const collected: Email[] = [];
  const seenIds = new Set<string>();

  try {
    const boxes = await session.listMailboxes();
    const searchable = boxes.filter((b) => !SKIP_MAILBOX.test(b.name));

    for (const box of searchable) {
      if (collected.length >= maxEmails) break;

      for (const sender of senders) {
        if (collected.length >= maxEmails) break;

        const raws = await session.fetchRawBySender(box.name, sender, since, maxEmails - collected.length);
        for (const r of raws) {
          if (collected.length >= maxEmails) break;
          const email = await parseRawEmail(r.source, `${box.name}:${r.uid}`);
          email.isRead = r.isRead;
          if (seenIds.has(email.id)) continue;
          seenIds.add(email.id);
          collected.push(email);
        }
      }
    }
  } finally {
    await session.close();
  }

  return collected;
}

// Parse a raw RFC822 source into our Email shape.
export async function parseRawEmail(source: Buffer | string, fallbackId: string): Promise<Email> {
  const parsed = await simpleParser(source);
  const from = parsed.from?.value?.[0];
  const html = typeof parsed.html === "string" ? parsed.html : "";
  const images = extractImagesFromHtml(html);
  const links = extractLinksFromHtml(html);

  const plain = parsed.text ?? "";
  const truncated = plain.length > 10000 ? plain.slice(0, 10000) : plain;
  const body = insertImageMarkers(truncated, images.length);

  return {
    id: parsed.messageId?.trim() || fallbackId,
    subject: parsed.subject ?? "",
    sender: from?.name || from?.address || "",
    senderEmail: (from?.address ?? "").toLowerCase(),
    date: (parsed.date ?? new Date()).toString(),
    body,
    links,
    images,
    isRead: false, // overridden by caller using IMAP flags
  };
}

export const fetchNewsletterEmails = traceable(_fetchNewsletterEmails, {
  name: "fetch-newsletter-emails",
  run_type: "tool",
});
