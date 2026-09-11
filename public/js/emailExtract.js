// Client-side mirror of services/emailExtractor.js (that file lives outside
// public/ and isn't served statically, so this is a deliberate, small,
// dependency-free duplicate kept in sync with the backend version). Used to
// live-suggest a recipient email as soon as the user pastes post text,
// before the request even reaches the server.
//
// Keep this in sync with services/emailExtractor.js — negation-awareness and
// the bare-obfuscation stoplist below were both added there to fix two
// concrete false-positive/false-preference bugs and must not drift out of
// sync here, or the live suggestion and the server's actual chosen recipient
// can disagree.

const PLAIN_EMAIL_RE = /[a-zA-Z0-9][a-zA-Z0-9._%+-]*@[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}/g;

// Known trade-off: bare "at"/"dot" can rarely false-positive on ordinary
// prose shaped like an email (see services/emailExtractor.js for the full
// rationale for keeping this permissive rather than requiring brackets).
const OBFUSCATED_EMAIL_RE = new RegExp(
  '([a-zA-Z0-9][a-zA-Z0-9._%+-]*)' +
    '\\s*([\\[(]?)\\s*(?:at|@)\\s*([\\])]?)\\s*' +
    '([a-zA-Z0-9][a-zA-Z0-9-]*(?:\\s*[\\[(]?\\s*(?:dot|\\.)\\s*[\\])]?\\s*[a-zA-Z0-9-]+)+)',
  'gi'
);

// Bare "word at word dot word" prose that reads as a verb/preposition
// phrase, not a mailbox name. Only applied when the "at" marker wasn't
// bracketed — see services/emailExtractor.js for the full rationale.
const LOCAL_PART_FALSE_POSITIVE_STOPLIST = new Set([
  'aim', 'aiming', 'look', 'looking', 'looked', 'reach', 'reaching', 'reached',
  'out', 'point', 'pointing', 'pointed', 'glance', 'glancing', 'glanced',
  'arrive', 'arriving', 'arrived', 'direct', 'directed', 'stare', 'staring',
  'stared', 'shoot', 'shooting', 'stop', 'stopping', 'stopped', 'get',
  'getting', 'got', 'head', 'heading', 'headed', 'laugh', 'laughing',
  'marvel', 'marvelling', 'wonder', 'wondering', 'best', 'good', 'better',
  'available', 'work', 'working', 'based'
]);

const IGNORED_TLDS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'pdf']);

// Negation cues — see services/emailExtractor.js for the full rationale.
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

function extractAllEmailsWithMetadata(text) {
  if (!text || typeof text !== 'string') return [];
  const byKey = new Map();
  const addIfNew = (email, matchIndex) => {
    const normalized = normalizeCandidate(email);
    if (!isPlausibleEmail(normalized)) return;
    const key = normalized.toLowerCase();
    const negatedHere = isNegatedAt(text, matchIndex);
    const existing = byKey.get(key);
    if (existing) {
      existing.negated = existing.negated && negatedHere;
      return;
    }
    byKey.set(key, { email: normalized, negated: negatedHere });
  };
  for (const match of text.matchAll(PLAIN_EMAIL_RE)) addIfNew(match[0], match.index);
  for (const match of text.matchAll(OBFUSCATED_EMAIL_RE)) {
    const [, local, openBracket, closeBracket, domainRaw] = match;
    const bracketed = Boolean(openBracket) || Boolean(closeBracket);
    if (!bracketed && LOCAL_PART_FALSE_POSITIVE_STOPLIST.has(local.toLowerCase())) continue;
    addIfNew(deobfuscate(local, domainRaw), match.index);
  }
  return Array.from(byKey.values());
}

export function extractAllEmails(text) {
  return extractAllEmailsWithMetadata(text).map((entry) => entry.email);
}

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
