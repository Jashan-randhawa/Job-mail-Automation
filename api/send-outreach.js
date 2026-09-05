import 'dotenv/config';
import crypto from 'crypto';
import { extractConceptAndDraft } from '../services/cerebrasService.js';
import { sendOutreachEmail } from '../services/emailService.js';
import { extractEmailFromText } from '../services/emailExtractor.js';
import { checkDraftSafety } from '../services/draftSafety.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// --- Why this file streams instead of returning one JSON blob ---
// Still no queue, no Redis, no job store — one request drafts and sends
// its own email start to finish. But "no queue" previously also meant "no
// visibility": the client sent one POST and just sat there until the
// whole thing finished. This writes newline-delimited JSON progress events
// as each phase happens (queued -> drafting -> drafted -> sending -> sent),
// so the UI can show real, not simulated, phase transitions. It's plain
// HTTP chunked-transfer streaming on Vercel's Node.js runtime (works with
// res.write/res.end the same as a local Express server) — no WebSocket, no
// SSE library, no extra infra.
//
// Because headers are sent before the outcome is known, HTTP status is
// always 200 once streaming starts; success/failure is carried in the
// final JSON event's `phase` field instead (`sent` vs `draft_failed` /
// `rejected` / `send_failed` / `send_unknown`). Input validation, and the
// cooldown check below, still fail fast with a normal 4xx JSON response,
// before any streaming begins.

// --- Send pacing (server-enforced) ---
// `POST_SEND_COOLDOWN_MS` (default 45s, matches the old client-only value)
// is now checked here, not just in public/js/main.js. `lastSendAt` is a
// plain module-level variable, which on Vercel means it lives in whatever
// Node.js worker process is currently warm for this function — it is NOT
// shared storage.
//
// What this buys you: as long as requests land on the same warm instance
// (the common case for one person clicking around, or two tabs/a reload
// hitting the function shortly after each other), a request arriving
// before the cooldown has elapsed is rejected immediately with 429 and a
// `retryAfterMs`, before any Groq call is made — so a reload or a second
// tab (or a raw curl) can no longer silently bypass the gap the way the
// old client-only timer allowed.
//
// What it does NOT buy you: true cross-instance guarantees. Vercel can
// spin up multiple concurrent instances of this function under real
// traffic, or recycle the instance to a cold one between requests, and
// each instance has its own `lastSendAt` starting at 0. For a single-user
// outreach tool sending one email at a time this is very unlikely to
// matter in practice, but if you need a hard cross-instance guarantee,
// swap `lastSendAt` for a shared store (e.g. Vercel KV / Upstash Redis)
// checked with a single atomic read-and-set — this module-level variable
// is deliberately the simple version, not that.
//
// The handler never sleeps inside the request to enforce this — that
// would eat into `vercel.json`'s 60s `maxDuration` for no benefit. It only
// ever rejects fast or lets the request straight through.
const POST_SEND_COOLDOWN_MS = Number(process.env.POST_SEND_COOLDOWN_MS) || 45_000;
let lastSendAt = 0; // ms timestamp of the last successful send from this instance; 0 until the first one

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  const { postText, recipientEmail } = req.body || {};
  if (!postText || !postText.trim()) {
    return res.status(400).json({ error: 'Paste the LinkedIn post text first.' });
  }

  let resolvedEmail = recipientEmail && recipientEmail.trim();
  let emailAutoDetected = false;
  if (!resolvedEmail || !EMAIL_RE.test(resolvedEmail)) {
    const detected = extractEmailFromText(postText);
    if (detected && EMAIL_RE.test(detected)) {
      resolvedEmail = detected;
      emailAutoDetected = true;
    }
  }
  if (!resolvedEmail || !EMAIL_RE.test(resolvedEmail)) {
    return res.status(400).json({ error: 'Enter a valid recipient email, or paste a post that includes one.' });
  }

  if (lastSendAt > 0) {
    const remainingMs = POST_SEND_COOLDOWN_MS - (Date.now() - lastSendAt);
    if (remainingMs > 0) {
      res.setHeader('Retry-After', String(Math.ceil(remainingMs / 1000)));
      return res.status(429).json({
        error: `Pacing sends to avoid looking automated — try again in ${Math.ceil(remainingMs / 1000)}s.`,
        retryAfterMs: remainingMs
      });
    }
  }

  const jobId = crypto.randomUUID();
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no' // in case anything in front of Vercel tries to buffer
  });
  const emit = (event) => res.write(JSON.stringify({ jobId, ...event }) + '\n');

  emit({ phase: 'queued', message: 'Request received.' });

  emit({ phase: 'drafting', message: 'Asking the LLM to read the post and draft an email.' });
  let draft;
  try {
    draft = await extractConceptAndDraft(postText.trim());
  } catch (err) {
    const message = err?.message || String(err);
    console.error(`[send-outreach] job=${jobId} draft_failed: ${message}`);
    emit({ phase: 'draft_failed', error: `Could not generate a draft: ${message}` });
    return res.end();
  }

  const { rejected, reason } = checkDraftSafety(draft);
  if (rejected) {
    console.error(`[send-outreach] job=${jobId} rejected: ${reason}`);
    emit({ phase: 'rejected', concept: draft.concept, subject: draft.subject, error: reason });
    return res.end();
  }

  emit({ phase: 'drafted', concept: draft.concept, subject: draft.subject, message: 'Draft passed the safety check.' });

  emit({ phase: 'sending', message: `Sending via Gmail SMTP to ${resolvedEmail}.` });
  try {
    await sendOutreachEmail({ to: resolvedEmail, subject: draft.subject, body: draft.body });
  } catch (err) {
    const message = err?.message || String(err);
    const status = message.toLowerCase().includes('timed out') ? 'send_unknown' : 'send_failed';
    console.error(`[send-outreach] job=${jobId} ${status}: ${message}`);
    emit({
      phase: status, concept: draft.concept, subject: draft.subject,
      error: `Draft looked good but sending failed: ${message}`
    });
    return res.end();
  }

  lastSendAt = Date.now();
  emit({
    phase: 'sent',
    recipientEmail: resolvedEmail,
    emailAutoDetected,
    concept: draft.concept,
    subject: draft.subject,
    message: 'Email sent.'
  });
  res.end();
}
