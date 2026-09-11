// Groq enforces rate limits per-organization on several dimensions at once
// (RPM, RPD, TPM, TPD) and returns 429 on whichever is hit first. For this
// app's prompt shape, TPM is the real constraint, not RPM: the fixed prompt
// template (candidate fact sheets + instructions) alone is ~3,800 tokens,
// and a single request's worst case (input + max_tokens) is close to 65% of
// the Free plan's entire 8,000 TPM budget — so firing more than one or two
// drafts concurrently can blow the per-minute token budget even though it's
// nowhere near the 30 RPM cap.
//
// This module gates outbound Groq calls with a sliding 60s window over both
// requests and tokens. server.js only ever has one job drafting at a time
// (a single-worker pacing loop, not a concurrent pool — see README), so in
// practice this paces one sequential call after another rather than
// arbitrating between concurrent callers; it's written generically against
// the request/token budget regardless, so it still holds correctly if that
// ever changes. Reservations are made using a conservative (worst-case
// token) estimate *before* the call, then reconciled down to the real usage
// from the response, so a slow start doesn't leave phantom budget unused.
//
// Defaults match Groq's published Free plan limits for openai/gpt-oss-20b
// (see https://console.groq.com/docs/rate-limits). If the account is on a
// higher tier, set GROQ_RPM_LIMIT / GROQ_TPM_LIMIT to match — check
// https://console.groq.com/settings/limits for the account's actual current
// numbers, since Groq raises these per-model and per-plan.
const RPM_LIMIT = Number(process.env.GROQ_RPM_LIMIT || 30);
const TPM_LIMIT = Number(process.env.GROQ_TPM_LIMIT || 8000);
let WINDOW_MS = 60_000; // mutable only via __rateLimiterTest, for fast tests

// Small safety margin below the hard cap — Groq's own token counting (BPE)
// won't exactly match our chars/4 estimate, so this leaves headroom rather
// than shaving reservations right up to the line.
const SAFETY_MARGIN = 0.9;

// Each entry: { at: timestamp, tokens: number }. `tokens` starts as the
// worst-case reservation and is mutated down to the real usage once known.
let entries = [];

function now() { return Date.now(); }

function prune(t) {
  entries = entries.filter((e) => t - e.at < WINDOW_MS);
}

function currentUsage(t) {
  prune(t);
  let tokens = 0;
  for (const e of entries) tokens += e.tokens;
  return { requests: entries.length, tokens };
}

// Rough, fast token estimate (chars/4) — good enough for a reservation
// bound; real usage is reconciled from the API response afterward via
// recordActualUsage.
export function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

function msUntilCapacity(t, estimatedTokens) {
  prune(t);
  const usage = currentUsage(t);
  const requestsOk = usage.requests + 1 <= RPM_LIMIT;
  const tokensOk = usage.tokens + estimatedTokens <= TPM_LIMIT * SAFETY_MARGIN;
  if (requestsOk && tokensOk) return 0;
  // Wait until the oldest entry ages out of the 60s window, which frees up
  // both some request-count and some token budget. Re-checked in a loop by
  // the caller in case that's still not enough.
  if (entries.length === 0) return 0; // nothing to wait on but still over budget — shouldn't happen unless a single reservation exceeds the cap outright
  const oldest = entries[0].at;
  return Math.max(0, WINDOW_MS - (t - oldest)) + 25; // +25ms slack past the exact boundary
}

/**
 * Blocks (async) until there's room under both the RPM and TPM sliding
 * windows for a call of roughly `estimatedTokens`, then reserves that slot
 * and returns a handle. Call `handle.settle(actualTokens)` once the real
 * response usage is known, to reconcile the reservation down (or up) to
 * what was actually consumed — keeps the window accurate for calls queued
 * up behind this one instead of staying pinned to the conservative estimate.
 */
export async function reserveGroqCapacity(estimatedTokens) {
  for (;;) {
    const t = now();
    const wait = msUntilCapacity(t, estimatedTokens);
    if (wait === 0) {
      const entry = { at: now(), tokens: estimatedTokens };
      entries.push(entry);
      return {
        settle(actualTokens) {
          if (typeof actualTokens === 'number' && Number.isFinite(actualTokens)) entry.tokens = actualTokens;
        }
      };
    }
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

// Exposes the live sliding-window length so callers that need to reason
// about worst-case queueing time (e.g. server.js sizing draftTimeoutMs)
// read the real value instead of hardcoding a second copy of "60000" that
// can silently drift out of sync with this module's actual window.
export function getRateLimitWindowMs() {
  return WINDOW_MS;
}

export const __rateLimiterTest = {
  reset() { entries = []; },
  getLimits() { return { RPM_LIMIT, TPM_LIMIT, WINDOW_MS }; },
  getUsage() { return currentUsage(now()); },
  setWindowMs(ms) { WINDOW_MS = ms; },
  resetWindowMs() { WINDOW_MS = 60_000; }
};