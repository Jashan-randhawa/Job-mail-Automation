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
// to share the shape ("we aim at domain dot com" -> "aim@domain.com").
// Requiring brackets around the bare words would close that gap, but it also
// breaks a real, intentionally-supported case — plenty of job posts write
// "Contact recruiter at acme dot com" with no brackets at all. Instead of an
// all-or-nothing bracket requirement, LOCAL_PART_FALSE_POSITIVE_STOPLIST
// below rejects bare-form matches whose "local part" is a common verb/
// preposition (aim, look, reach, out, ...) rather than something that reads
// like an actual mailbox name — that specifically catches the "verb + at"
// prose pattern without losing genuine unbracketed addresses, since a real
// local part essentially never collides with these words.
const OBFUSCATED_EMAIL_RE = new RegExp(
  '([a-zA-Z0-9][a-zA-Z0-9._%+-]*)' + // local part
    '\\s*([\\[(]?)\\s*(?:at|@)\\s*([\\])]?)\\s*' + // at / [at] / (at) — captures brackets so callers can tell bracketed from bare
    '([a-zA-Z0-9][a-zA-Z0-9-]*(?:\\s*[\\[(]?\\s*(?:dot|\\.)\\s*[\\])]?\\s*[a-zA-Z0-9-]+)+)', // domain with dot(s)
  'gi'
);

// Bare "word at word dot word" prose that reads as a verb/preposition
// phrase, not a mailbox name. Only applied when the "at" marker wasn't
// bracketed ([at]/(at)) — bracketed forms are unambiguous regardless of the
// local-part word, since nobody writes "[at]" by accident in prose.
const LOCAL_PART_FALSE_POSITIVE_STOPLIST = new Set([
  'aim', 'aiming', 'look', 'looking', 'looked', 'reach', 'reaching', 'reached',
  'out', 'point', 'pointing', 'pointed', 'glance', 'glancing', 'glanced',
  'arrive', 'arriving', 'arrived', 'direct', 'directed', 'stare', 'staring',
  'stared', 'shoot', 'shooting', 'stop', 'stopping', 'stopped', 'get',
  'getting', 'got', 'head', 'heading', 'headed', 'laugh', 'laughing',
  'marvel', 'marvelling', 'wonder', 'wondering', 'best', 'good', 'better',
  'available', 'work', 'working', 'based'
]);

// Image/asset filenames and common false-positive TLD-lookalikes that slip
// through the plain regex when a post links to a file (e.g. "flyer@2x.png").
const IGNORED_TLDS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'pdf']);

// Negation cues that, if they appear shortly before a matched address,
// mean the post is telling the reader NOT to use that address (e.g. "Do NOT
// email hr@company.com, email hiring@company.com instead"). The address is
// still returned by extractAllEmails (dropping information silently is
// worse than surfacing it), but extractEmailFromText deprioritizes it below
// any non-negated candidate.
const NEGATION_RE = /\b(do not|don't|dont|do n't|never|avoid|not|no longer|instead of|rather than)\b/i;
const NEGATION_WINDOW_CHARS = 30;

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

function deobfuscate(local, domainRaw) {
  const domain = domainRaw
    .replace(/\s*[\[(]?\s*dot\s*[\])]?\s*/gi, '.')
    .replace(/\s+/g, '')
    .replace(/^\.+|\.+$/g, '');
  return `${local}@${domain}`;
}

function isNegatedAt(text, matchIndex) {
  const start = Math.max(0, matchIndex - NEGATION_WINDOW_CHARS);
  return NEGATION_RE.test(text.slice(start, matchIndex));
}

/**
 * Returns every plausible email address found in the given text, in the
 * order encountered, deduplicated (case-insensitive) while preserving the
 * first-seen casing. Each entry also reports whether it appeared in a
 * negated context ("do not email X") everywhere it was found.
 */
function extractAllEmailsWithMetadata(text) {
  if (!text || typeof text !== 'string') return [];

  const byKey = new Map(); // lowercase email -> { email, negated }

  const addIfNew = (email, matchIndex) => {
    const normalized = normalizeCandidate(email);
    if (!isPlausibleEmail(normalized)) return;
    const key = normalized.toLowerCase();
    const negatedHere = isNegatedAt(text, matchIndex);
    const existing = byKey.get(key);
    if (existing) {
      // Only still "negated" overall if every occurrence was negated — an
      // address mentioned once negatively and once as the real instruction
      // should not be penalized.
      existing.negated = existing.negated && negatedHere;
      return;
    }
    byKey.set(key, { email: normalized, negated: negatedHere });
  };

  for (const match of text.matchAll(PLAIN_EMAIL_RE)) addIfNew(match[0], match.index);

  // Only fall back to the obfuscated pattern for addresses not already
  // caught above (plain form is unambiguous, obfuscated form has more false
  // positive surface).
  for (const match of text.matchAll(OBFUSCATED_EMAIL_RE)) {
    const [, local, openBracket, closeBracket, domainRaw] = match;
    const bracketed = Boolean(openBracket) || Boolean(closeBracket);
    if (!bracketed && LOCAL_PART_FALSE_POSITIVE_STOPLIST.has(local.toLowerCase())) continue;
    addIfNew(deobfuscate(local, domainRaw), match.index);
  }

  return Array.from(byKey.values());
}

/**
 * Returns every plausible email address found in the given text, in the
 * order encountered, deduplicated (case-insensitive) while preserving the
 * first-seen casing.
 */
export function extractAllEmails(text) {
  return extractAllEmailsWithMetadata(text).map((entry) => entry.email);
}

/**
 * Returns the single best-guess recipient email from the given post text, or
 * null if none was found. Preference order: a non-negated address whose
 * local part hints at a hiring contact (hr, jobs, careers, recruit...) >
 * any other non-negated address (first found) > a negated hiring-hint
 * address > any negated address (first found). This means "Do NOT email
 * hr@company.com, email hiring@company.com" correctly prefers
 * hiring@company.com even though hr@ is mentioned first and also matches
 * the hiring-hint pattern.
 */
export function extractEmailFromText(text) {
  const entries = extractAllEmailsWithMetadata(text);
  if (entries.length === 0) return null;
  if (entries.length === 1) return entries[0].email;

  const HIRING_HINT_RE = /^(hr|hiring|jobs?|careers?|recruit(ing|er|ment)?|talent|apply)/i;
  const score = (entry) => {
    const hinted = HIRING_HINT_RE.test(entry.email.split('@')[0]);
    if (!entry.negated && hinted) return 0;
    if (!entry.negated) return 1;
    if (hinted) return 2;
    return 3;
  };

  const sorted = [...entries].sort((a, b) => score(a) - score(b));
  return sorted[0].email;
}
