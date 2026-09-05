# Changelog

## v1.2.0

### Fixed

- **A single flaky Groq response permanently failed a draft.** The most
  common cause is Groq's own `response_format: { type: 'json_object' }`
  mode occasionally rejecting a generation server-side before it reaches
  this app at all — surfacing as `400 Failed to validate JSON. Please
  adjust your prompt. See 'failed_generation' for more details.` The same
  prompt usually succeeds on a second attempt, but `extractConceptAndDraft`
  had no retry at all, so one hiccup meant the job sat in `draft_failed`
  until someone noticed and clicked Retry.
  - `services/cerebrasService.js` now retries automatically (new
    `GROQ_DRAFT_MAX_ATTEMPTS`, default `3`) on: Groq's json_object
    schema-validation rejection, rate limits and server errors (429/5xx),
    and our own parsing coming up short (invalid JSON, missing
    subject/body). A short jittered backoff runs between attempts, and
    retries add a stricter "JSON only" reminder to the prompt.
  - A non-retryable error (bad API key, unknown model, etc.) still fails
    immediately on the first attempt — this isn't a blanket "retry
    everything" change.
  - This applies to both Path A and Path B, since both call the same
    shared `extractConceptAndDraft`.
  - If every attempt is exhausted, behavior is unchanged from before: the
    job lands in `draft_failed` and can be retried manually.

### Added

- `test/cerebrasServiceRetry.test.js` — mocks the Groq client directly to
  verify: retries on the json_object validation failure, retries on 503,
  gives up after `GROQ_DRAFT_MAX_ATTEMPTS`, does *not* retry a
  non-retryable error (401), and still eventually surfaces a
  missing-subject/body failure after exhausting retries.

### Notes

- No changes to `server.js`'s existing timeout/stale-job-recovery/retry
  infrastructure — it already worked correctly and didn't need
  duplicating. This release only closes the one real gap: no retry
  existed *inside* a single draft attempt.

---

## v1.1.0

### Fixed

- **Send cooldown on Vercel (Path B) is now enforced server-side.** Previously
  the 45-second gap between outreach emails lived only in
  `public/js/main.js` as a browser-tab timer — it reset on page reload,
  didn't apply across tabs, and did nothing at all for a request sent
  directly to `/api/send-outreach` (curl, Postman, another script).
  `api/send-outreach.js` now tracks the last successful send and rejects
  an early request with `429` + `retryAfterMs` before any Groq/Gmail call
  is made. New optional env var: `POST_SEND_COOLDOWN_MS` (default `45000`).
  The frontend treats `429` as expected pacing and retries automatically,
  so this is invisible in normal use.
  - Known limitation (documented in code): the tracked timestamp lives in
    a plain in-memory variable scoped to whichever Vercel serverless
    instance is currently warm, not shared storage. Strong for the common
    single-user case; not a hard guarantee across concurrent instances.

- **Missing `.gitignore`.** The README has long stated that `profile.json`,
  `resume/resume.pdf`, and `.env` are "gitignored," but no `.gitignore`
  file actually existed in the repository. Depending on how this repo was
  set up, that could mean personal data (name, phone, email, resume) or
  secrets (Gmail App Password, Groq API key) were one `git add .` away
  from being committed. Added a `.gitignore` that actually excludes:
  `.env`/`.env.*`, `profile.json`, `resume/*.pdf`, `data/*.json` (queue
  state / dry-run drafts), `node_modules/`, `.vercel/`, and OS/editor
  cruft. **If you have an existing repo, check `git log` for these files
  and scrub/rotate any leaked secrets — adding `.gitignore` now does not
  remove them from history.**

- Removed a stray 1-byte junk file (`public/assets/hero-frames/s`) that
  had been accidentally committed.

### Added

- `test/sendOutreachCooldown.test.js` — exercises the Path B handler
  directly (mocking the Groq draft + Gmail send calls) to verify the
  cooldown: first send succeeds → an immediate second attempt is rejected
  with `429` and never calls the draft/send services → a send succeeds
  again once the cooldown elapses → validation errors still short-circuit
  before the cooldown check runs.
- `npm test` now runs with `--experimental-test-module-mocks` (Node 22+)
  to support the mocking above.

### Notes

- Path A (`server.js`) was not affected by the cooldown bug — its
  `MIN_SEND_INTERVAL_MS`/`SEND_JITTER_MAX_MS` pacing already lives
  server-side in the in-memory queue/worker and needed no change.

---

## v1.0.0

Initial tagged snapshot: dual-path outreach tool (Express queue/worker for
persistent hosts, Vercel streaming function for serverless), Groq-drafted
emails with a safety gate, Gmail SMTP sending, resume attachment,
recipient auto-detection from pasted post text, and a static frontend
with live job-status ledger.
