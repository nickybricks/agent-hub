import {
  getDb,
  clearAuditFindings as clearAuditFindingsSqlite,
  insertAuditFindings as insertAuditFindingsSqlite,
  startAuditRun as startAuditRunSqlite,
  finishAuditRun as finishAuditRunSqlite,
  failAuditRun as failAuditRunSqlite,
  AuditFindingInput,
  AuditFindingKind,
} from "../lib/analyzer-db";
import {
  clearAuditFindingsPg,
  insertAuditFindingsPg,
  startAuditRunPg,
  finishAuditRunPg,
  failAuditRunPg,
  loadAllMessagesPg,
} from "../lib/analyzer-db-pg";
import { isMultiTenant } from "../lib/db";

export interface MsgRow {
  id: string;
  sender_email: string;
  sender_name: string | null;
  subject: string | null;
  date_received: string;
  is_read: number;
  size_bytes: number;
  mailbox_id: number;
  mailbox_name: string;
  headers_json: string | null;
  category: string | null;
}

function selfEmail(): string {
  return (process.env.IMAP_USER || "").toLowerCase();
}

function isSpamMailbox(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes("spam") || n.includes("junk");
}

function isInboxMailbox(name: string): boolean {
  return name.toLowerCase() === "inbox";
}

function parseHeaders(json: string | null): { auth?: string; lu?: string; prec?: string; as?: string } {
  if (!json) return {};
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

type AuthVerdict = "pass" | "fail" | "softfail" | "neutral" | "none" | "temperror" | "permerror";
interface AuthResults { dmarc?: AuthVerdict; spf?: AuthVerdict; dkim?: AuthVerdict }

const VERDICT_RANK: Record<AuthVerdict, number> = {
  pass: 3, fail: 2, softfail: 2, neutral: 1, none: 0, temperror: 0, permerror: 0,
};

function parseAuthResults(auth: string | undefined): AuthResults {
  if (!auth) return {};
  const out: AuthResults = {};
  const re = /\b(dmarc|spf|dkim)\s*=\s*(pass|fail|softfail|neutral|none|temperror|permerror)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(auth)) !== null) {
    const method = m[1].toLowerCase() as keyof AuthResults;
    const verdict = m[2].toLowerCase() as AuthVerdict;
    const cur = out[method];
    if (!cur || VERDICT_RANK[verdict] > VERDICT_RANK[cur]) out[method] = verdict;
  }
  return out;
}

export function loadAllMessages(): MsgRow[] {
  return getDb().prepare(`
    SELECT m.id, m.sender_email, m.sender_name, m.subject, m.date_received,
           m.is_read, m.size_bytes, m.mailbox_id, m.headers_json,
           mb.name AS mailbox_name,
           s.category AS category
    FROM messages m
    JOIN mailboxes mb ON m.mailbox_id = mb.id
    LEFT JOIN senders s ON LOWER(m.sender_email) = s.email
    WHERE LOWER(m.sender_email) != ?
  `).all(selfEmail()) as MsgRow[];
}

export interface SenderAgg {
  email: string;
  category: string | null;
  total: number;
  inSpam: MsgRow[];
  outOfSpam: number;
  inInbox: MsgRow[];
  read: number;
  totalSize: number;
  lastDate: string;
  hasListUnsubscribe: boolean;
  spamAuthPass: boolean;
  displayName: string;
  subjects: string[];
  dmarcSeen: number;
  dmarcPass: number;
  dmarcFail: number;
  dmarcPassInSpam: number;
}

export function aggregate(rows: MsgRow[]): Map<string, SenderAgg> {
  const map = new Map<string, SenderAgg>();
  for (const r of rows) {
    const email = r.sender_email.toLowerCase();
    let s = map.get(email);
    if (!s) {
      s = {
        email,
        category: r.category,
        total: 0,
        inSpam: [],
        outOfSpam: 0,
        inInbox: [],
        read: 0,
        totalSize: 0,
        lastDate: r.date_received,
        hasListUnsubscribe: false,
        spamAuthPass: false,
        displayName: r.sender_name ?? "",
        subjects: [],
        dmarcSeen: 0,
        dmarcPass: 0,
        dmarcFail: 0,
        dmarcPassInSpam: 0,
      };
      map.set(email, s);
    }
    if (!s.displayName && r.sender_name) s.displayName = r.sender_name;
    if (r.subject && s.subjects.length < 5) s.subjects.push(r.subject);
    s.total++;
    s.totalSize += r.size_bytes || 0;
    if (r.is_read) s.read++;
    if (r.date_received > s.lastDate) s.lastDate = r.date_received;
    const inSpam = isSpamMailbox(r.mailbox_name);
    if (inSpam) s.inSpam.push(r);
    else s.outOfSpam++;
    if (isInboxMailbox(r.mailbox_name)) s.inInbox.push(r);

    const headers = parseHeaders(r.headers_json);
    if (headers.lu) s.hasListUnsubscribe = true;
    const auth = parseAuthResults(headers.auth);
    if (auth.dmarc) {
      s.dmarcSeen++;
      if (auth.dmarc === "pass") {
        s.dmarcPass++;
        if (inSpam) s.dmarcPassInSpam++;
      } else if (auth.dmarc === "fail") {
        s.dmarcFail++;
      }
    }
    if (inSpam && auth.dkim === "pass") s.spamAuthPass = true;
    if (inSpam && auth.spf === "pass") s.spamAuthPass = true;
  }
  return map;
}

const LEGIT_CATEGORIES = new Set(["transactional", "personal", "work", "newsletter"]);
const DEMOTE_CATEGORIES = new Set(["promotional", "notification"]);

export function scoreFalsePositiveSpam(s: SenderAgg): { score: number; reasons: string[] } | null {
  if (s.inSpam.length === 0) return null;
  // Hard gate: require prior non-spam evidence. Category alone is not enough,
  // because Phase 2 classifies phishing as 'transactional' from the subject.
  const hasPriorTrust = s.outOfSpam >= 1 || s.spamAuthPass;
  if (!hasPriorTrust) return null;
  // Phishing-shaped senders are excluded even if they slip the trust gate
  // (e.g. one stray non-spam delivery from a sketchy domain).
  if (scorePhishingRisk(s)) return null;

  let score = 0;
  const reasons: string[] = [];
  if (s.outOfSpam >= 1) {
    score += 0.4;
    reasons.push(`${s.outOfSpam} message(s) previously received outside Spam`);
  }
  if (s.outOfSpam > s.inSpam.length) {
    score += 0.2;
    reasons.push("majority of mail outside Spam");
  }
  if (s.dmarcPassInSpam > 0) {
    score += 0.4;
    reasons.push(`DMARC pass on ${s.dmarcPassInSpam} Spam-folder message(s)`);
  } else if (s.spamAuthPass) {
    score += 0.2;
    reasons.push("SPF/DKIM pass on Spam-folder message");
  }
  if (s.category && LEGIT_CATEGORIES.has(s.category)) {
    score += 0.1;
    reasons.push(`category=${s.category}`);
  }
  if (s.category && DEMOTE_CATEGORIES.has(s.category)) {
    score -= 0.2;
    reasons.push(`category=${s.category} (weak signal)`);
  }
  if (score < 0.5) return null;
  return { score: Math.min(1, score), reasons };
}

const SUSPICIOUS_TLDS = new Set([
  "ink", "top", "xyz", "click", "buzz", "rest", "fit", "support", "live",
  "online", "shop", "loan", "win", "monster", "review", "country", "kim", "men",
  "icu", "cyou", "sbs", "cfd", "quest", "lol", "bond", "skin", "homes", "makeup",
]);

const BRAND_NAMES = [
  "amazon", "americanexpress", "amex", "apple", "paypal", "stripe", "google",
  "microsoft", "outlook", "ionos", "telekom", "deutschebank", "ing", "sparkasse",
  "dhl", "hermes", "ups", "fedex", "dpd", "post", "ebay", "lufthansa", "klarna",
  "netflix", "spotify", "facebook", "instagram", "linkedin", "sumup", "shopify",
  "revolut", "n26", "comdirect", "slack", "github", "gitlab", "atlassian",
];

function domainOf(email: string): string {
  return email.split("@")[1]?.toLowerCase() ?? "";
}

function tldOf(email: string): string {
  return domainOf(email).split(".").pop() ?? "";
}

const TWO_PART_TLDS = new Set([
  "co.uk", "com.au", "com.br", "com.pl", "co.jp", "com.tr", "co.nz", "co.za",
  "com.mx", "com.ar", "com.sg", "com.hk", "com.cn", "com.tw", "co.kr", "co.il",
  "com.eg", "co.in", "co.id", "com.my", "co.th", "com.ph", "com.ua", "co.at",
]);

export function registrableDomain(domain: string): string {
  const parts = domain.split(".");
  if (parts.length < 2) return domain;
  const lastTwo = parts.slice(-2).join(".");
  if (TWO_PART_TLDS.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join(".");
  }
  return lastTwo;
}

function registrableBase(domain: string): string {
  return registrableDomain(domain).split(".")[0];
}

export function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function looksLikeBrandImpersonation(email: string, displayName: string): boolean {
  const domain = domainOf(email);
  const reg = registrableDomain(domain);
  const base = reg.split(".")[0];
  const regLabels = reg.split(".");
  const dnTokens = tokenize(displayName);
  const baseTokens = base.split(/[^a-z0-9]+/).filter(Boolean);

  // If any brand appears in the display name AND is also the registrable base,
  // the mail is legitimately from that brand — multi-brand display names are fine.
  const vouchedBrand = BRAND_NAMES.find(
    (b) => dnTokens.includes(b) && (base === b || regLabels.includes(b))
  );
  if (vouchedBrand) return false;

  for (const brand of BRAND_NAMES) {
    const dnHit = dnTokens.includes(brand);
    if (dnHit && !regLabels.includes(brand)) return true;
    // brand baked into a multi-token registrable label (e.g. "americanexpress-preis148")
    if (baseTokens.length >= 2 && baseTokens.includes(brand) && base !== brand) return true;
  }
  return false;
}

function hasHomoglyphInSubject(subject: string): boolean {
  // capital-I inside an otherwise lowercase word (l→I substitution, e.g. "MitgIied")
  if (/[a-z]I[a-z]/.test(subject)) return true;
  // zero inside an otherwise alpha word
  if (/[a-zA-Z]0[a-zA-Z]/.test(subject)) return true;
  return false;
}

function hasRandomLocalPart(email: string): boolean {
  const local = email.split("@")[0] ?? "";
  if (local.length < 12) return false;
  const segs = local.split(/[-_.]/);
  return segs.some(
    (s) => s.length >= 8 && /\d/.test(s) && /[a-z]/i.test(s) && !/^[a-z]+$/i.test(s)
  );
}

const URGENCY_RE = /\b(zahl|bestätig|sicherheit|lieferung|aktualisier|verify|confirm|password|payment|invoice|account|locked|suspend|verifizier|update|fehlgeschlag|nicht möglich|jetzt|neu planen|mitglied)/i;

// Domains whose subdomains routinely emit "random" local parts (tracking IDs,
// relay addresses, plus-addressed account IDs). Match either as a registrable
// base OR as a suffix of the full domain.
const TRUSTED_DOMAINS = new Set([
  "appleid.com",
  "gmail.com",
  "googlemail.com",
  "ebay-kleinanzeigen.de",
  "ebay-classifieds.com",
  "kleinanzeigen.de",
  "paypal.com",
  "paypal.de",
  "icloud.com",
  "me.com",
  "mac.com",
  "hotmail.com",
  "outlook.com",
  "yahoo.com",
  "yahoo.de",
  "gmx.de",
  "gmx.net",
  "web.de",
  "t-online.de",
  "amazonses.com",
  "sendgrid.net",
  "mailgun.org",
  "formitable.com",
  "icims.com",
  "mailchimp.com",
  "substack.com",
  "beehiiv.com",
  "intercom.io",
  "sendinblue.com",
  "mailerlite.com",
  "hubspot.com",
  "salesforce.com",
  "notion.so",
  "linear.app",
]);

function domainIsTrusted(domain: string): boolean {
  const base = registrableBase(domain);
  // BRAND_NAMES at the registrable base means the domain is a real first-party
  // brand domain (stripe.com, amazon.de, facebook.com, paypal.com, …).
  if (BRAND_NAMES.includes(base)) return true;
  for (const d of TRUSTED_DOMAINS) {
    if (domain === d || domain.endsWith("." + d)) return true;
  }
  return false;
}

function hasStrongDmarcTrust(s: SenderAgg): boolean {
  // Multiple messages all authenticated by the claimed domain owner.
  return s.dmarcSeen >= 3 && s.dmarcPass / s.dmarcSeen >= 0.8;
}

function hasDmarcFailure(s: SenderAgg): boolean {
  // Any DMARC fail on a sender claiming a brand is highly suspicious.
  return s.dmarcSeen >= 1 && s.dmarcFail / s.dmarcSeen >= 0.5;
}

export function scorePhishingRisk(s: SenderAgg, threshold = 0.5): { score: number; reasons: string[] } | null {
  if (domainIsTrusted(domainOf(s.email))) return null;
  // DMARC-passing senders with history are the same domain owner the From: claims.
  // Unless they spoof a brand in the display name, they're authentic.
  if (hasStrongDmarcTrust(s) && (!s.displayName || !looksLikeBrandImpersonation(s.email, s.displayName))) {
    return null;
  }

  // Primary signals: only these can trigger a finding.
  let primary = 0;
  // Secondary signals: amplify a primary signal but never trigger alone.
  let secondary = 0;
  const reasons: string[] = [];

  if (hasDmarcFailure(s)) {
    primary += 0.4;
    reasons.push(`DMARC fail on ${s.dmarcFail}/${s.dmarcSeen} authenticated message(s)`);
  }

  if (SUSPICIOUS_TLDS.has(tldOf(s.email))) {
    primary += 0.4;
    reasons.push(`suspicious TLD .${tldOf(s.email)}`);
  }

  if (s.displayName && looksLikeBrandImpersonation(s.email, s.displayName)) {
    primary += 0.4;
    reasons.push(`display name "${s.displayName}" doesn't match domain ${domainOf(s.email)}`);
  }

  if (s.subjects.some(hasHomoglyphInSubject)) {
    primary += 0.3;
    reasons.push("homoglyph in subject");
  }

  if (primary === 0) return null;

  if (hasRandomLocalPart(s.email)) {
    secondary += 0.2;
    reasons.push("random-string local part");
  }

  if (s.total === 1 && s.subjects.some((subj) => URGENCY_RE.test(subj))) {
    secondary += 0.3;
    reasons.push("one-off message with urgency/transactional subject");
  }

  const score = primary + secondary;
  if (score < threshold) return null;
  return { score: Math.min(1, score), reasons };
}

function scoreFalseNegativeInbox(s: SenderAgg): { score: number; reasons: string[] } | null {
  if (s.inInbox.length < 5) return null;
  let score = 0;
  const reasons: string[] = [];
  if (s.category && DEMOTE_CATEGORIES.has(s.category)) {
    score += 0.4;
    reasons.push(`category=${s.category}`);
  }
  if (s.hasListUnsubscribe) {
    score += 0.2;
    reasons.push("List-Unsubscribe header present");
  }
  const readRate = s.total > 0 ? s.read / s.total : 0;
  if (s.total >= 10 && readRate < 0.05) {
    score += 0.3;
    reasons.push(`${(readRate * 100).toFixed(0)}% read rate over ${s.total} messages`);
  }
  if (s.inInbox.length >= 20) {
    score += 0.1;
    reasons.push(`${s.inInbox.length} in Inbox`);
  }
  if (score < 0.4) return null;
  return { score: Math.min(1, score), reasons };
}

function scoreStaleSender(s: SenderAgg, cutoffISO: string): { score: number; reasons: string[] } | null {
  const recent = [...s.inSpam, ...s.inInbox].filter((m) => m.date_received >= cutoffISO);
  if (recent.length < 5) return null;
  const readRecent = recent.filter((m) => m.is_read).length;
  if (readRecent > 0) return null;
  return {
    score: Math.min(1, recent.length / 50),
    reasons: [`${recent.length} message(s) in last 12 months, 0 opened`],
  };
}

export async function runAudit(userId: string | null = null): Promise<number> {
  const kinds: AuditFindingKind[] = [
    "false_positive_spam",
    "false_negative_inbox",
    "phishing_risk",
    "hygiene_stale_sender",
    "hygiene_storage_hog",
  ];
  if (userId) await clearAuditFindingsPg(userId, kinds);
  else clearAuditFindingsSqlite(kinds);

  const rows = userId ? await loadAllMessagesPg(userId) : loadAllMessages();
  const senders = aggregate(rows);

  const findings: AuditFindingInput[] = [];

  for (const s of senders.values()) {
    const fp = scoreFalsePositiveSpam(s);
    if (fp) {
      findings.push({
        kind: "false_positive_spam",
        sender_email: s.email,
        mailbox_id: null,
        message_ids: s.inSpam.map((m) => m.id).slice(0, 200),
        suggested_action: "move_to_inbox",
        score: fp.score,
        reasoning: fp.reasons.join("; "),
      });
    }
    const phish = scorePhishingRisk(s);
    if (phish) {
      findings.push({
        kind: "phishing_risk",
        sender_email: s.email,
        mailbox_id: null,
        message_ids: [...s.inSpam, ...s.inInbox].map((m) => m.id).slice(0, 200),
        suggested_action: "block_sender",
        score: phish.score,
        reasoning: phish.reasons.join("; "),
      });
    }
    const fn = scoreFalseNegativeInbox(s);
    if (fn) {
      findings.push({
        kind: "false_negative_inbox",
        sender_email: s.email,
        mailbox_id: null,
        message_ids: s.inInbox.map((m) => m.id).slice(0, 200),
        suggested_action: s.hasListUnsubscribe ? "unsubscribe_or_route" : "route_out_of_inbox",
        score: fn.score,
        reasoning: fn.reasons.join("; "),
      });
    }
  }

  const cutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
  for (const s of senders.values()) {
    const stale = scoreStaleSender(s, cutoff);
    if (stale) {
      findings.push({
        kind: "hygiene_stale_sender",
        sender_email: s.email,
        mailbox_id: null,
        message_ids: [...s.inSpam, ...s.inInbox]
          .filter((m) => m.date_received >= cutoff)
          .map((m) => m.id)
          .slice(0, 200),
        suggested_action: "unsubscribe",
        score: stale.score,
        reasoning: stale.reasons.join("; "),
      });
    }
  }

  const topBySize = [...senders.values()]
    .filter((s) => s.totalSize > 0)
    .sort((a, b) => b.totalSize - a.totalSize)
    .slice(0, 10);
  for (const s of topBySize) {
    findings.push({
      kind: "hygiene_storage_hog",
      sender_email: s.email,
      mailbox_id: null,
      message_ids: [],
      suggested_action: "review_for_archive",
      score: Math.min(1, s.totalSize / (topBySize[0]?.totalSize || 1)),
      reasoning: `${(s.totalSize / 1024 / 1024).toFixed(1)} MB across ${s.total} message(s)`,
    });
  }

  if (userId) await insertAuditFindingsPg(userId, findings);
  else insertAuditFindingsSqlite(findings);
  return findings.length;
}

async function main() {
  const MT = isMultiTenant();
  const userId = MT ? process.env.DEV_USER_ID ?? null : null;
  if (MT && !userId) {
    console.error("MULTI_TENANT=true requires DEV_USER_ID env var.");
    process.exit(1);
  }

  const runId = userId ? await startAuditRunPg(userId) : startAuditRunSqlite();
  try {
    const count = await runAudit(userId);
    if (userId) await finishAuditRunPg(userId, runId, count);
    else finishAuditRunSqlite(runId, count);
    console.log(`Audit complete. ${count} finding(s) written.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (userId) await failAuditRunPg(userId, runId, msg);
    else failAuditRunSqlite(runId, msg);
    console.error("Audit failed:", msg);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
