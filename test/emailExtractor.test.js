// Extracts a recipient email address directly out of pasted post text, so
// the user doesn't have to go copy it out of the post by hand. LinkedIn/job
// posts commonly write the address in one of a few ways:
//   - plain:            "Send your resume to hr@acme.com"
//   - de-obfuscated:    "hr [at] acme [dot] com", "hr(at)acme(dot)com"
//   - spaced-out:       "hr @ acme . com"
// This module is deliberately dependency-free and side-effect-free so it can
// be reused from both the Express backend (services/*, server.js) and, if
// ever needed, bundled for the frontend.

// Standard email shape. Deliberately conservative (no unicode/edge-case TLD
// handling) — false negatives just mean the user types the address in
// manually, which is the pre-existing behavior; false positives are worse
// because they'd silently misdirect an outreach email.
const PLAIN_EMAIL_RE = /[a-zA-Z0-9][a-zA-Z0-9._%+-]*@[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}/g;

// Obfuscated form: "local [at] domain [dot] tld" / "local (at) domain (dot) tld"
// / "local at domain dot tld", with flexible spacing/casing around the
// at/dot markers. Built once at module load, not per-call.
//
// Known trade-off: because "at"/"dot" are also ordinary English words, bare
// (unbracketed) forms can occasionally false-positive on prose that happens
// to share the shape ("available at github dot io for the demo" →
// "available@github.io"). Requiring brackets around the bare words would
// close that gap, but it also breaks a real, intentionally-supported,
// tested case — plenty of job posts write "Contact recruiter at acme dot
// com" with no brackets at all, and losing that is a worse trade for this
// app's actual usage than the rare false positive. Bracketed forms ([at],
// (at)) remain the unambiguous, zero-risk case; bare forms are a deliberate
// bet on job-post text specifically being far more likely to contain real
// contact info than incidental "word at word dot word" phrasing.
const OBFUSCATED_EMAIL_RE = new RegExp(
  '([a-zA-Z0-9][a-zA-Z0-9._%+-]*)' + // local part
    '\\s*[\\[(]?\\s*(?:at|@)\\s*[\\])]?\\s*' + // at / [at] / (at)
    '([a-zA-Z0-9][a-zA-Z0-9-]*(?:\\s*[\\[(]?\\s*(?:dot|\\.)\\s*[\\])]?\\s*[a-zA-Z0-9-]+)+)', // domain with dot(s)
  'gi'
);

// Image/asset filenames and common false-positive TLD-lookalikes that slip
// through the plain regex when a post links to a file (e.g. "flyer@2x.png").
const IGNORED_TLDS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'pdf']);

function normalizeCandidate(raw) {
  return raw.trim().replace(/[.,;:]+$/, '');
}

function isPlausibleEmail(email) {
  const at = email.indexOf('@');
  if (at <= 0 || at === email.length - 1) return false;
  const domain = email.slice(at + 1);
  const tld = domain.split('.').pop().toLowerCase();
  if (IGNORED_TLDS.has(tld)) return false;
  if (tld.length < 2) return false;
  return true;
}

function deobfuscate(match, local, domainRaw) {
  const domain = domainRaw
    .replace(/\s*[\[(]?\s*dot\s*[\])]?\s*/gi, '.')
    .replace(/\s+/g, '')
    .replace(/^\.+|\.+$/g, '');
  return `${local}@${domain}`;
}

/**
 * Returns every plausible email address found in the given text, in the
 * order encountered, deduplicated (case-insensitive) while preserving the
 * first-seen casing.
 */
export function extractAllEmails(text) {
  if (!text || typeof text !== 'string') return [];

  const found = [];
  const seen = new Set();

  const addIfNew = (email) => {
    const normalized = normalizeCandidate(email);
    if (!isPlausibleEmail(normalized)) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push(normalized);
  };

  for (const match of text.matchAll(PLAIN_EMAIL_RE)) addIfNew(match[0]);

  // Only fall back to the obfuscated pattern for addresses not already
  // caught above (plain form is unambiguous, obfuscated form has more false
  // positive surface, e.g. "reach out at Acme dot com's careers page").
  for (const match of text.matchAll(OBFUSCATED_EMAIL_RE)) {
    addIfNew(deobfuscate(match[0], match[1], match[2]));
  }

  return found;
}

/**
 * Returns the single best-guess recipient email from the given post text, or
 * null if none was found. When multiple addresses appear, prefers one whose
 * local part hints at a hiring contact (hr, jobs, careers, recruit...) over
 * a generic/personal-looking one, then falls back to the first found.
 */
export function extractEmailFromText(text) {
  const emails = extractAllEmails(text);
  if (emails.length === 0) return null;
  if (emails.length === 1) return emails[0];

  const HIRING_HINT_RE = /^(hr|hiring|jobs?|careers?|recruit(ing|er|ment)?|talent|apply)/i;
  const hinted = emails.find((email) => HIRING_HINT_RE.test(email.split('@')[0]));
  return hinted || emails[0];
}