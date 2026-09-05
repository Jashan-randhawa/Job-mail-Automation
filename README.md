# 📬 Job Mail Automation — AI LinkedIn Outreach Bot

**Paste a LinkedIn job post → an LLM reads it, drafts a personalized outreach email, attaches your resume, and sends it — with no manual review step in between.**

Built with Node.js, Express, Groq's LLM API, and Nodemailer. Ships with **two independent, production-ready ways to run it**: a persistent Express server with a real job queue, or a serverless Vercel function — pick whichever matches where you're deploying.

---

## Table of Contents

1. [What This Project Does](#what-this-project-does)
2. [Key Features](#key-features)
3. [How It Works — Request Lifecycle](#how-it-works--request-lifecycle)
4. [Two Ways to Run This](#two-ways-to-run-this)
5. [Tech Stack](#tech-stack)
6. [Project Structure](#project-structure)
7. [The Drafting Engine — How the AI Writes the Email](#the-drafting-engine--how-the-ai-writes-the-email)
8. [Email Address Extraction](#email-address-extraction)
9. [The Safety Gate](#the-safety-gate)
10. [Queueing & Batching (Path A)](#queueing--batching-path-a)
11. [Rate Limiting Groq Calls](#rate-limiting-groq-calls)
12. [HTML Email Rendering](#html-email-rendering)
13. [Persistence](#persistence)
14. [Candidate Profile — Making This Your Own](#candidate-profile--making-this-your-own)
15. [Local Setup](#local-setup)
16. [Environment Variables](#environment-variables)
17. [Running the Tests](#running-the-tests)
18. [API Endpoints](#api-endpoints)
19. [Frontend / Backend Compatibility](#frontend--backend-compatibility)
20. [Deployment](#deployment)
21. [Draft-Only / Dry-Run Mode](#draft-only--dry-run-mode)
22. [Tracking Your Applications](#tracking-your-applications)
23. [Important Notes & Caveats](#important-notes--caveats)
24. [License](#license)

---

## What This Project Does

You find a hiring post on LinkedIn. Instead of writing a cold email by hand, tailoring it, attaching your resume, and hitting send — you paste the post text into this tool. From there it:

1. **Detects the recruiter's email** directly from the pasted text (handles plain, obfuscated, and spaced-out formats).
2. **Classifies the role** (technical, sales/business, customer care, or hybrid) and picks the right set of facts about you to draw from.
3. **Drafts a complete, personalized email** — subject line, salutation, a hook referencing the actual post, a proof paragraph with a real metric from your background, logistics, and a call to action.
4. **Runs a safety check** on the draft (no placeholders, no eligibility red flags, not suspiciously short).
5. **Sends it via Gmail SMTP** with your resume attached, as a nicely formatted HTML email with a plain-text fallback.
6. **Paces itself** so outreach goes out in small, human-looking bursts instead of a mechanical drip.

The whole thing is designed to run unattended for a batch of job posts, so you spend your time finding good roles, not writing emails.

## Key Features

- 🤖 **LLM-drafted, role-aware emails** — a single prompt classifies the post and picks from three separate fact blocks (technical, sales/business, customer care) so a sales-role email doesn't read like a copy-pasted engineering pitch.
- 📧 **Automatic recipient detection** — pulls a contact email straight out of the pasted post, including de-obfuscated forms like `hr [at] acme [dot] com`.
- 🛡️ **A safety gate before every send** — rejects empty, too-short, placeholder-riddled drafts, and skips posts whose requirements the candidate profile doesn't meet (protected-characteristic eligibility criteria) rather than drafting around them.
- 📦 **Human-like batching & pacing (Path A)** — jobs assemble into small batches with randomized jitter between sends, rather than firing off in a mechanical, easily-flagged pattern.
- 💾 **Crash-safe persistence (Path A)** — the entire job/batch queue survives restarts via a debounced, atomic JSON file write.
- ⚡ **Two deployment targets, one codebase** — a stateful Express server for Render/Railway/Fly.io/VPS, or a stateless streaming Vercel function, sharing the same drafting, sending, and extraction logic.
- 🎯 **Groq-aware rate limiting** — paces LLM calls against your account's real RPM/TPM budget instead of blindly firing requests and eating 429s.
- 🧪 **A real test suite** — Node's built-in test runner covers the queue state machine, email extraction, prompt classification, and rate limiter.
- 🧵 **Dry-run mode** — review your first 10–20 AI-drafted emails on disk before a single one touches a real recruiter's inbox.
- 🎨 **A polished, animated dark/light frontend** (`public/index.html`) with live status/progress feedback per submission.

## How It Works — Request Lifecycle

```
┌──────────────┐    ┌───────────────┐    ┌───────────────┐    ┌──────────────┐    ┌────────────┐
│ 1. Paste post │ →  │ 2. Extract    │ →  │ 3. LLM drafts │ →  │ 4. Safety    │ →  │ 5. Send +  │
│   + email     │    │   email addr  │    │   the email   │    │   gate       │    │   attach   │
│  (optional)   │    │  (if omitted) │    │  (Groq LLM)   │    │              │    │   resume   │
└──────────────┘    └───────────────┘    └───────────────┘    └──────────────┘    └────────────┘
```

1. **Paste a post.** If the pasted text contains a contact email — plain (`hr@acme.com`) or de-obfuscated (`hr [at] acme [dot] com`, `hr(at)acme(dot)com`) — the **Recipient** field auto-fills. A manually entered address always wins over auto-detection, both in the browser and again server-side as a fallback if the field is left blank.
2. **Draft.** An LLM (via Groq's OpenAI-compatible API — defaults to `openai/gpt-oss-20b`, swappable to anything else in your Groq account's model catalog) extracts the concept behind the post — company, role, tech stack, whatever it's actually about — classifies the role type, and writes a subject + body using only the matching fact block(s) from your profile.
3. **Safety gate.** Before anything sends, the draft is checked for being empty, missing a subject, suspiciously short, containing leftover placeholder text (like `[Company]`), or flagged for an eligibility mismatch. If it fails, nothing sends.
4. **Send.** If it passes, the email goes out via Gmail SMTP with your resume attached, as HTML with a plain-text fallback.
5. **Track.** How this step works depends on which of the two deployment paths below you're running.

## Two Ways to Run This

This repo contains **two independent implementations** of the same idea, sharing `config/`, `services/`, and the frontend under `public/`, but different in how a submission is processed and what the API looks like. Pick one per environment — they are not interchangeable (see [Frontend / Backend Compatibility](#frontend--backend-compatibility)).

### A. Persistent server — `server.js`

For Render, Railway, Fly.io, a VPS, or running locally with `npm start`.

- A single Express app holds an **in-memory FIFO job queue**, a **batching layer** on top of it, and a background worker — job map, queue array, batch map, and a single-worker pacing loop (jobs draft and send one at a time, not concurrently), all driven by a `setInterval` sweep.
- Jobs move through explicit states:
  `queued → processing → drafting → waiting → sending → sent`
  (terminal failures: `draft_failed`, `send_failed`, `send_unknown`, `rejected`).
- **Jobs send in batches, not one at a time.** New jobs assemble into a batch of `BATCH_SIZE` (default 3). Once a batch fills up (or has been assembling longer than `ORPHAN_BATCH_TIMEOUT_MS` — default 2h — without filling), it locks and becomes eligible to run `BATCH_DELAY_MS` later (default 45 minutes). Only one batch processes at a time, in arrival order. Within a processing batch, sends are still paced individually: after drafting, a job sits in `waiting` until `MIN_SEND_INTERVAL_MS` (default 45s) plus random jitter (`SEND_JITTER_MAX_MS`, default 20s) has elapsed since the last send.
- The frontend polls `GET /api/status/:jobId` every 3s per submitted job to show live queue position, ETA, and status as it progresses. `GET /api/jobs` (worker state, recent jobs, and a `batches` summary) is also available.
- **Persistence**: queue and batch state is written to a JSON file (`QUEUE_PERSIST_PATH`, default `data/queue-state.json`) after every state change, debounced by `QUEUE_PERSIST_DEBOUNCE_MS` (default 250ms). On startup, this file is loaded and any batch that matured while the process was down is evaluated immediately.
- **Self-healing.** An independent, wall-clock stale-job sweep (`STALE_SWEEP_INTERVAL_MS`, default 15s) recovers any job stuck past its processing timeout, so a hung draft or send can never permanently jam the queue.

### B. Vercel serverless — `api/*.js`

For Vercel, using the function under `api/`.

- **No queue, no database.** Every request to `POST /api/send-outreach` drafts *and* sends its own email, start to finish, inside that one function invocation — nothing is shared or persisted between requests.
- The response is a **streamed, newline-delimited JSON** body (one HTTP request, chunked transfer): the client reads a line per phase as it actually happens — `queued` → `drafting` → `drafted` → `sending` → `sent` (or a failure phase: `draft_failed`, `rejected`, `send_failed`, `send_unknown`) — instead of waiting on one opaque response.
- Because headers are sent before the outcome is known, HTTP status is always `200` once streaming starts; success/failure is carried in the final JSON event's `phase` field instead. Input validation still fails fast with a normal 4xx JSON response, before any streaming begins.
- **Pacing is enforced server-side.** `api/send-outreach.js` tracks the timestamp of the last successful send (`POST_SEND_COOLDOWN_MS`, default 45s, matches Path A's default) and rejects a request that arrives too soon with `429` + `retryAfterMs`, before any Groq call is made — so a page reload, a second tab, or a raw `curl`/script hitting the endpoint directly can no longer bypass the gap. `public/js/main.js` handles the `429` automatically (waits, then resends) so this is invisible in normal use; it also keeps a local pre-check so this tab doesn't fire off a request it can predict will bounce. The one caveat: the tracked timestamp lives in a plain variable scoped to whichever Vercel serverless instance is currently warm, not a shared store — see the comment in `api/send-outreach.js` for what that does and doesn't guarantee across concurrent instances.
- "Retry" just means resubmitting the same post text and recipient again — there's no job id to retry against.
- `vercel.json` sets `maxDuration: 60` on `api/send-outreach.js` since drafting + sending both have to complete inside one request.

## Tech Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js (ESM) |
| Backend (Path A) | Express 5, in-memory job queue + worker (`server.js`) |
| Backend (Path B) | Vercel Functions (`api/`) |
| LLM | Groq — OpenAI-compatible API via the `openai` SDK (default model `openai/gpt-oss-20b`) |
| Email | Nodemailer via Gmail SMTP (intentionally unpooled — see [Important Notes](#important-notes--caveats)) |
| Frontend | Static HTML/CSS/JS (`public/`), animated hero, dark/light theme toggle |
| Tests | Node's built-in test runner (`node --test`) |
| Deployment | Persistent Node process (Render, Railway, Fly.io, a VPS, local) **or** Vercel serverless functions |

## Project Structure

```
server.js                        Path A: Express app, /api routes, in-memory job queue + worker
api/send-outreach.js             Path B: Vercel function — drafts + sends synchronously, streams NDJSON progress
config/profile.js                Resolves the candidate profile (name, links, facts) from profile.json / env vars / built-in defaults
profile.example.json             Copy to profile.json to customize the candidate identity without editing code
services/cerebrasService.js      Prompt + call to Groq's LLM API, JSON parsing, role classification (shared by both paths)
services/emailService.js         Nodemailer transport, HTML rendering, resume attachment (shared by both paths)
services/emailExtractor.js       Extracts a recipient email from pasted post text (shared by both paths)
services/draftSafety.js          Shared safety-gate logic (placeholder/length/eligibility checks)
services/groqRateLimiter.js      Paces Groq requests to stay under RPM/TPM limits (shared by both paths)
persistence/store.js             Atomic JSON-file load/save for Path A's queue state
public/index.html                The form UI
public/js/main.js                Form submission, streaming-progress UI, cooldown pre-check + automatic 429 retry (Path B)
public/js/emailExtract.js        Client-side mirror of emailExtractor.js (live-fills the form as you type)
public/js/smooth-scroll.js       Smooth in-page scrolling for nav links
public/css/, public/img/, public/assets/  Frontend styling, images, and hero animation frames/video
resume/                          Put resume.pdf here
data/                            Queue persistence + dry-run drafts live here (created automatically)
test/                            Node test-runner suite — queue.test.js covers Path A specifically; the rest cover shared services
Job_Application_Tracker.xlsx     Standalone spreadsheet for logging every application you send
.env.example                     Copy to .env and fill in
vercel.json                      Path B only: function config for api/send-outreach.js
```

## The Drafting Engine — How the AI Writes the Email

All prompt logic lives in `services/cerebrasService.js` (named for historical reasons — the actual provider is **Groq**, not Cerebras). The LLM is given the raw post text plus three fact blocks from your candidate profile, and told to:

**Step 0 — Check eligibility.** If the post states a requirement tied to a protected characteristic (e.g. "female candidates only", a specific age range, marital status, religion) that nothing in your profile indicates you meet, the model does **not** try to word around it. It sets `eligibilityFlag` to a short phrase describing the mismatch instead, which the safety gate then rejects downstream — so the tool never sends an email under false pretenses. An ordinary experience-level shortfall (e.g. "5+ years" for a final-year student) is *not* treated as an eligibility flag — the model is instead told to pivot the hook toward what's genuinely true (rapid ramp-up, shipped results, portfolio) without pretending to a seniority that isn't real.

**Step 1 — Classify the role** into exactly one of:
- `TECHNICAL` — engineering, dev, data, ML, or other hands-on technical roles.
- `SALES_BUSINESS` — sales, business development, account management, marketing, ops.
- `CUSTOMER_CARE` — support, customer success, community, help-desk, telecalling.
- `HYBRID` — roles blending technical work with business/customer-facing work.

**Step 2 — Pick the matching fact block(s).** The model is told never to invent, exaggerate, or borrow a fact/number/company/title from a block that doesn't match — and never to invent a business metric (like a "CSAT score") that was never actually measured, even when bridging a technical achievement to a non-technical role.

**Step 3 — Write the email** in an exact 4-paragraph structure:
1. **Subject line** — specific, human, tied to the role (never a bare "Application" or "Hello").
2. **Salutation** — "Dear Hiring Manager," or "Dear [Company] Team," if the company is named.
3. **Paragraph 1 (hook)** — references 2–3 specific things actually said in the post.
4. **Paragraph 2 (proof)** — the single best-matching achievement from your fact block(s), with its real metric.
5. **Paragraph 3 (logistics)** — your graduation year, degree, and availability (pulled from your profile).
6. **Paragraph 4 (call to action)** — ties two relevant skills to the post's stated goal, mentions the attached resume.
7. **Sign-off** — "Sincerely," + your name, nothing after it (contact links are appended separately, not trusted to the model).

The whole body targets **150–200 words**, professional tone, no hype words ("guarantee", "amazing opportunity", "act now"), no bracketed placeholders. The model must respond with **only a JSON object** — no markdown fences, no commentary — matching a strict schema (`roleCategory`, `eligibilityFlag`, `concept`, `subject`, `body`), which is then defensively parsed (stripping stray code fences or an echoed "Subject:" label) before being handed to the safety gate.

**Retrying transient draft failures.** Groq's `response_format: { type: 'json_object' }` mode occasionally rejects a generation server-side before it ever reaches this app — surfacing as `400 Failed to validate JSON... see 'failed_generation'` — and the same prompt usually succeeds on a second attempt. `extractConceptAndDraft` retries automatically (`GROQ_DRAFT_MAX_ATTEMPTS`, default 3) on that error, on Groq rate limits/server errors (429/5xx), and on our own parsing coming up short (invalid JSON, missing subject/body) — with a brief backoff and a stricter JSON-only reminder added to the prompt on the retry. A non-retryable error (bad API key, unknown model) still fails on the first attempt. If every attempt is exhausted, the job lands in `draft_failed` as before and can still be retried manually via `POST /api/jobs/:jobId/retry` (Path A) or by resubmitting (Path B).

## Email Address Extraction

`services/emailExtractor.js` (mirrored client-side in `public/js/emailExtract.js` for instant feedback as you type) pulls a recipient address directly out of the pasted post text, handling:

- **Plain** addresses: `hr@acme.com`
- **De-obfuscated** forms: `hr [at] acme [dot] com`, `hr(at)acme(dot)com`, `hr at acme dot com`
- **Spaced-out** forms: `hr @ acme . com`

It's deliberately conservative and dependency-free:
- Filters out obvious non-emails like image filenames (`flyer@2x.png`).
- Recognizes **negation cues** ("do not email X, email Y instead") and deprioritizes the negated address.
- Prefers an address whose local part hints at a hiring contact (`hr`, `jobs`, `careers`, `recruit…`, `talent`, `apply`) over a generic one.
- Uses a stoplist to avoid false-positiving on ordinary prose like "we aim at domain dot com" when the "at" isn't bracketed.

A manually typed recipient email always overrides auto-detection.

## The Safety Gate

Before anything sends, `services/draftSafety.js` — shared by both `server.js` and `api/send-outreach.js` so the two entry points can never drift apart — rejects a draft if:

- it's missing a subject, or the body is empty/under ~50 characters,
- it still contains bracketed placeholder text (e.g. `[Company]`),
- the model flagged a protected-characteristic **eligibility mismatch** (see above).

A rejected draft is terminal for that attempt — nothing is sent, and retrying re-prompts the model fresh rather than trying to auto-correct the same draft.

## Queueing & Batching (Path A)

`server.js` implements a full, testable in-memory queue with:

- **Explicit, validated state transitions** — an illegal transition (e.g. `queued → sending`) throws immediately rather than silently corrupting state.
- **O(1) queue position & dequeue** — jobs track their own sequence number instead of scanning the array, and dequeuing advances a pointer instead of `Array.shift()`, so draining a large burst of jobs stays linear instead of quadratic.
- **Batching on top of the FIFO** — jobs are grouped into fixed-size batches (`BATCH_SIZE`) before they're even eligible to be claimed by the worker. A batch locks once full, or after sitting unfilled for `ORPHAN_BATCH_TIMEOUT_MS`. Only the front-most batch is ever being processed at a time, keeping sends in arrival order and grouped into human-looking bursts rather than a steady drip.
- **A wall-clock stale-job sweep**, independent of the drain loop itself, that recovers any job stuck past its timeout — this is the real backstop that guarantees recovery even if the main loop were ever blocked on something unbounded.
- **Bounded memory** — completed jobs/batches beyond `JOB_RETENTION_LIMIT` / `BATCH_RETENTION_LIMIT` are pruned (oldest-completed first; active/queued jobs are never touched), and per-job event history is capped at `JOB_EVENT_LIMIT`.
- **Invariant checking** (`assertQueueInvariants`) that logs a diagnostic if the queue ever ends up in a corrupt state (duplicate ids, more than one active job, a mismatched `activeJobId`, etc.) — used heavily by the test suite.

## Rate Limiting Groq Calls

`services/groqRateLimiter.js` paces outbound Groq calls against a **sliding 60-second window** over both request count and token usage, because Groq's free-tier token-per-minute budget (`GROQ_TPM_LIMIT`, default 8000) is the real constraint for this app's prompt shape — the fixed prompt template alone runs close to half that budget. Each call:

1. Reserves a conservative worst-case token estimate *before* the request.
2. Blocks (without busy-waiting) until there's room under both the RPM and TPM windows.
3. **Reconciles** the reservation down to the real token usage once the response comes back, so the window stays accurate for anything queued behind it.

## HTML Email Rendering

Sent emails are HTML (`services/emailService.js`), not plain text, with a plain-text fallback in the same message for clients/screen readers that don't render HTML. The model's plain-text draft — paragraphs separated by blank lines — is converted into `<p>`/`<ul><li>` HTML with no external CSS or images (to avoid tripping spam filters), and a clickable signature (phone + Portfolio/GitHub/LinkedIn links) is appended after the model's sign-off rather than trusting the model to reproduce URLs verbatim every time.

The SMTP transporter is **intentionally unpooled** — a pooled connection can go stale after Gmail closes it server-side, leaving the next send hanging on a dead socket until the timeout kills it. Opening a fresh connection per send costs a little latency but is what's actually reliable here.

## Persistence

`persistence/store.js` gives Path A's queue crash-safety with the simplest thing that works: a single JSON file, written **atomically** (write to a temp file, then rename over the target, so a crash mid-write can never leave a half-written, unparseable state file). This is explicitly a single-writer store — fine for one server instance, not a substitute for a real database if you ever run more than one.

## Candidate Profile — Making This Your Own

`config/profile.js` is the single source of truth for "who this tool sends email as," resolved in this priority order:

1. **`profile.json`** at the repo root (gitignored — copy `profile.example.json` to create it).
2. **Per-field environment variables** (`CANDIDATE_NAME`, `CONTACT_PHONE`, `PORTFOLIO_LINK`, `GITHUB_LINK`, `LINKEDIN_LINK`, `DEGREE`, `GRADUATION_YEAR`, `AVAILABILITY`, `RESUME_ATTACHMENT_FILENAME`).
3. **Built-in defaults** — so the app still runs out of the box even if you set up nothing.

Your `profile.json` supplies three separate **fact blocks** — `techFacts`, `salesFacts`, `customerCareFacts` — that the drafting prompt chooses between based on the classified role (see [The Drafting Engine](#the-drafting-engine--how-the-ai-writes-the-email)). Each block supports a `{{name}}` placeholder so it stays reusable even if you only override the `name` field.

## Local Setup

**1. Install dependencies**
```bash
npm install
```

**2. Add your resume**

Drop your resume PDF into `resume/` and name it exactly `resume.pdf` (or set `RESUME_PATH` in `.env` to point somewhere else).

**3. Set up your candidate profile (optional but recommended)**

By default the app drafts and signs emails as the original author — that's the built-in fallback so it still runs out of the box, but you'll almost certainly want to replace it:
```bash
cp profile.example.json profile.json
```
Fill in your name, contact links, and fact blocks (see the defaults in `config/profile.js` for the level of detail/format to aim for). `profile.json` is gitignored, so your real background never gets committed. You can also override just the name via `CANDIDATE_NAME` without touching the fact blocks.

**4. Get a Groq API key**

Free self-serve tier at [console.groq.com/keys](https://console.groq.com/keys). Pick any model from your account's catalog at [console.groq.com/docs/models](https://console.groq.com/docs/models) and set it as `GROQ_MODEL` (optional — defaults to `openai/gpt-oss-20b`).

**5. Get a Gmail App Password**

Regular Gmail passwords don't work for SMTP anymore. You need:
- 2-Step Verification turned on for your Google account
- An App Password from [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
- Use that 16-character password, not your normal one

**6. Configure environment variables**
```bash
cp .env.example .env
```
Fill in `GROQ_API_KEY`, `EMAIL_USER`, and `EMAIL_APP_PASSWORD`. Everything else is optional and defaults sensibly (see the table below).

**7. Run it**

Path A (persistent server, e.g. testing what you'd deploy to Render):
```bash
npm start          # production
npm run dev         # auto-restart on file changes (node --watch)
```
Open [http://localhost:3000](http://localhost:3000).

Path B (Vercel functions): use the [Vercel CLI](https://vercel.com/docs/cli) — `vercel dev` — to run `api/send-outreach.js` locally the way Vercel would.

**8. Run the tests**
```bash
npm test
```

## Environment Variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `GROQ_API_KEY` | **Yes** | — | Auth for Groq's OpenAI-compatible API |
| `EMAIL_USER` | **Yes** | — | Gmail address to send from |
| `EMAIL_APP_PASSWORD` | **Yes** | — | Gmail App Password (not your normal password) |
| `GROQ_MODEL` | No | `openai/gpt-oss-20b` | Any model in your Groq account's catalog |
| `GROQ_RPM_LIMIT` / `GROQ_TPM_LIMIT` | No | `30` / `8000` | Per-minute request/token caps the rate limiter paces against — match to your actual Groq plan/model |
| `GROQ_DRAFT_MAX_ATTEMPTS` | No | `3` | Retries for a single draft on a transient Groq error (429/5xx, or Groq's own json_object schema-validation rejection) before the job fails |
| `PORT` | No | `3000` | Local server port (Path A only) |
| `RESUME_PATH` | No | `./resume/resume.pdf` | Where the resume PDF lives |
| `REPLY_TO_EMAIL` | No | same as `EMAIL_USER` | Reply-to address if different from the sending address |
| `MIN_SEND_INTERVAL_MS` / `SEND_JITTER_MAX_MS` | No | `45000` / `20000` | Minimum gap + random jitter between sends *within* a processing batch (Path A only) |
| `POST_SEND_COOLDOWN_MS` | No | `45000` | Minimum gap between sends, enforced server-side with a `429` (Path B only) |
| `BATCH_SIZE` | No | `3` | Jobs per batch (Path A only) |
| `BATCH_DELAY_MS` | No | `2700000` (45 min) | Delay between a batch locking and it becoming eligible to send (Path A only) |
| `ORPHAN_BATCH_TIMEOUT_MS` | No | `7200000` (2h) | If a batch never fills up to `BATCH_SIZE`, promote it anyway after this long (Path A only) |
| `QUEUE_PERSIST_PATH` | No | `./data/queue-state.json` | Where queue/batch state is persisted between restarts (Path A only) |
| `QUEUE_PERSIST_DEBOUNCE_MS` | No | `250` | Minimum gap between persisted writes (Path A only) |
| `JOB_RETENTION_LIMIT` / `BATCH_RETENTION_LIMIT` | No | `1000` / `500` | Oldest-terminal-first cap on completed jobs/batches kept in memory |
| `JOB_EVENT_LIMIT` / `JOB_LIST_LIMIT` | No | `50` / `100` | Per-job event history cap, and max jobs returned by the list endpoint (Path A only) |
| `DRAFT_TIMEOUT_MS` / `SEND_TIMEOUT_MS` | No | `60000` / `60000` | Per-phase timeout for drafting and sending a single job (Path A only) |
| `WAIT_TIMEOUT_MS` / `JOB_PROCESSING_TIMEOUT_MS` | No | `600000` / `300000` | Timeout while a job waits for its send slot, and overall stale-job cutoff (Path A only) |
| `STALE_SWEEP_INTERVAL_MS` | No | `15000` | How often the independent stale-job sweep runs (Path A only) |
| `ESTIMATED_DRAFT_SECONDS` / `ESTIMATED_SEND_SECONDS` | No | `20` / `10` | Rough per-phase seconds used only to estimate a job's ETA in the UI (Path A only) |
| `DRY_RUN` / `DRY_RUN_LOG_PATH` | No | off / `./data/drafts.json` | Draft-only mode — see [below](#draft-only--dry-run-mode) |
| `CANDIDATE_NAME` | No | built-in default | Overrides the "From" display name and resume filename without a `profile.json` |
| `CONTACT_EMAIL` | No | falls back to `EMAIL_USER` | Public contact email shown in the signature |
| `CONTACT_PHONE` / `PORTFOLIO_LINK` / `GITHUB_LINK` / `LINKEDIN_LINK` | No | built-in defaults | Per-field overrides for the signature block |
| `DEGREE` / `GRADUATION_YEAR` / `AVAILABILITY` | No | built-in defaults | Filled into the drafting prompt's logistics paragraph — keep current as your status changes |
| `RESUME_ATTACHMENT_FILENAME` | No | built-in default | Filename the resume is attached as (separate from `RESUME_PATH`, which is where it's read from) |
| `PROFILE_PATH` | No | `./profile.json` | Override where the profile JSON is read from |
| `NODE_ENV` | No | — | Set to `test` to suppress `server.js`'s own `app.listen()` (used by the test suite) |

> Startup only **warns** (doesn't crash) if `GROQ_API_KEY`, `EMAIL_USER`, or `EMAIL_APP_PASSWORD` are missing — but every job/request will fail until they're set.

## Running the Tests

```bash
npm test
```

Runs Node's built-in test runner (`node --test --test-concurrency=1 --test-force-exit`) against:

| File | Covers |
|---|---|
| `test/queue.test.js` | Path A's full state machine — transitions, batching, retries, invariants, stale recovery |
| `test/emailExtractor.test.js` | Plain/obfuscated/spaced email detection, negation handling, false-positive stoplist |
| `test/groqRateLimiter.test.js` | Sliding-window RPM/TPM pacing and reservation reconciliation |
| `test/promptClassification.test.js` | The drafting prompt keeps its fact sets, classification rules, and anti-fabrication instructions intact |
| `test/sendOutreachEmailDetection.test.js` | End-to-end email-detection behavior through the send-outreach flow |
| `test/sendOutreachCooldown.test.js` | Path B's server-enforced send cooldown (429 + retryAfterMs) |
| `test/cerebrasServiceRetry.test.js` | Draft-generation retry behavior on transient Groq errors |

## API Endpoints

### Path A (`server.js`)

| Endpoint | Description |
|---|---|
| `POST /api/send-outreach` | Queues a new job. Returns `202` with `jobId`, `position`, and `etaSeconds`. |
| `POST /api/jobs/:jobId/retry` | Re-queues a failed/rejected job at the back of the queue, preserving `retryCount`. |
| `GET /api/status/:jobId` | Detailed status for one job — lifecycle timestamps, phase, queue position/ETA, event history. |
| `GET /api/jobs` | Current worker state, batch summary, and a list of recent jobs. |

### Path B (`api/*.js`)

| Endpoint | Description |
|---|---|
| `POST /api/send-outreach` | Drafts and sends synchronously. Response is `200` with a newline-delimited JSON stream of phase events (`queued`, `drafting`, `drafted`, `sending`, then a terminal phase: `sent`, `draft_failed`, `rejected`, `send_failed`, or `send_unknown`). Input validation errors (bad email, empty post) return a normal `4xx` JSON response before streaming starts. |

## Frontend / Backend Compatibility

`public/js/main.js` is served by both paths and branches on the response's `Content-Type` to speak whichever protocol it's actually talking to: `application/x-ndjson` means Path B (stream progress; a `429` mid-flow means the server-side cooldown hasn't cleared yet, handled by an automatic wait-and-retry); anything else means Path A's single `202 { jobId, position, etaSeconds, ... }` response, which the frontend then polls `GET /api/status/:jobId` for every 3 seconds until the job reaches a terminal status. On Path A the submit button re-enables immediately after queuing instead of waiting on a client-side cooldown, since the server's own queue/batch pacing already spaces sends out. Failed jobs retry via `POST /api/jobs/:jobId/retry` on Path A, or by resubmitting as a new job on Path B (there's no job store to retry against there).

## Deployment

### Path A: Render (or any host that runs a persistent Node process)

1. Push this repo to your Git host (`.env`, `profile.json`, and `resume/resume.pdf` stay out automatically via `.gitignore`).
2. On Render: create a new **Web Service** from this repo — build command `npm install`, start command `npm start`.
3. Set `GROQ_API_KEY`, `EMAIL_USER`, `EMAIL_APP_PASSWORD` as environment variables in Render's dashboard (everything else is optional).
4. Make sure the resume PDF (and `profile.json`, if used) end up on the instance — since `.gitignore` keeps them out of git by design, upload them via Render's dashboard/shell, a build step, or a deploy-only copy outside `.gitignore`.

Railway, Fly.io, and a plain VPS work the same way — anything that keeps one Node process alive continuously.

### Path B: Vercel

1. Push this repo to your Git host.
2. Import the repo as a new Vercel project. `vercel.json` already configures `api/send-outreach.js`'s function settings — no extra framework config needed.
3. Set `GROQ_API_KEY`, `EMAIL_USER`, `EMAIL_APP_PASSWORD` as environment variables in the Vercel dashboard.
4. Resume and profile: since `resume/resume.pdf` / `profile.json` are gitignored by design, commit a deploy-only copy outside `.gitignore`, or adjust `RESUME_PATH` / `PROFILE_PATH` to read from somewhere your build includes.

No Redis, KV, or other storage add-on is required for this path.

## Draft-Only / Dry-Run Mode

Set `DRY_RUN=1` in `.env` before your first real run. Drafting still happens for real (Groq is called, the safety gate still runs), but `sendOutreachEmail` skips Gmail entirely and appends the would-be email — recipient, subject, body, resume filename, timestamp, both plain-text and HTML versions — to `data/drafts.json` instead. Read through your first 10–20 drafts for tone and accuracy before flipping `DRY_RUN` off. Once you're happy, consider self-sending a batch to a secondary email address of your own for a final real-world check before pointing the tool at real recruiters.

## Tracking Your Applications

`Job_Application_Tracker.xlsx` (repo root) is a standalone spreadsheet — separate from this tool's own in-memory/queue tracking — for logging every application: company, role, recruiter contact, the specific post/JD link, date applied, status, and a follow-up date. Row 2 is a greyed-out example showing the expected format; the pale-yellow rows below it are yours to fill in (Status and "Draft Reviewed?" are dropdowns). The Summary tab totals things up automatically as you go.

## Important Notes & Caveats

- **No human review step, by design.** The safety gate is the only thing standing between a bad draft and a real recruiter's inbox — it catches empty, too-short, or placeholder-riddled drafts, but it can't catch a draft that's simply wrong in tone. Worth spot-checking the first several sends, or running with `DRY_RUN=1` first.
- **Gmail's sending limits apply** (roughly 500/day on a free account) — fine for personal outreach volume, not built for bulk sending.
- **Cloud providers often block outbound SMTP.** Render, Railway, and other free-tier PaaS hosts frequently throttle or block ports 465/587 by default. If Gmail SMTP isn't reachable from your host, an HTTP-based email API (SendGrid, Brevo, Resend) is the usual fallback.
- **The SMTP transporter is intentionally unpooled** — see [HTML Email Rendering](#html-email-rendering) for why; don't re-add connection pooling without also handling stale-connection detection.
- **Swap the sender identity** by setting `CANDIDATE_NAME` or editing `profile.json` — the drafting prompt's contact links and signature block are resolved from `config/profile.js`, so update your profile there rather than hardcoding elsewhere if you fork this for someone else.
- **Model choice is a runtime setting** — change `GROQ_MODEL` in `.env` (or your host's dashboard) without touching code.

## License

ISC — see `package.json`.

---

Built by **Jashanpreet Singh** — [Portfolio](https://jashan2978.vercel.app) · [GitHub](https://github.com/Jashan-randhawa)
