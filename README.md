# Job Mail Automation — AI LinkedIn Outreach Bot

Paste the text of a LinkedIn job/hiring post, and this tool extracts the recruiter's email, has an LLM draft a personalized outreach email from your profile, runs it through a safety check, and sends it via Gmail with your resume attached — no manual writing or review step required.

Built with Node.js (ES modules), Express, Groq's OpenAI-compatible LLM API, and Nodemailer. It ships as **two independent entry points** sharing the same core logic, so you can pick whichever fits how you deploy it.

## What it actually does

1. **Extracts the recipient email** from the pasted post text — handles plain addresses (`hr@acme.com`), de-obfuscated ones (`hr [at] acme [dot] com`, `hr(at)acme(dot)com`), and spaced-out variants. A manually typed address always overrides auto-detection.
2. **Classifies the role** the post is hiring for (technical, sales/business, customer care, or a hybrid) and picks the matching fact block(s) from your candidate profile so the email doesn't read like a generic template.
3. **Drafts a full email** with an LLM (Groq, default model `openai/gpt-oss-20b`) — subject line, a hook that references the actual post, a proof point pulled from your real experience, logistics (availability/graduation), and a closing call to action.
4. **Flags eligibility mismatches instead of drafting around them.** If a post states a requirement tied to a protected characteristic that your profile doesn't meet, the model reports it and the job is skipped rather than sent under false pretenses.
5. **Runs a safety gate** before anything goes out: rejects empty/too-short drafts, leftover placeholder text (e.g. `[Company]`), or a missing subject.
6. **Sends via Gmail SMTP** with your resume attached, as HTML with a plain-text fallback.
7. **Paces sends** so outreach goes out in small, human-looking bursts rather than a mechanical drip.

## Two ways to run it

| | Path A — Express server | Path B — Vercel function |
|---|---|---|
| File | `server.js` | `api/send-outreach.js` |
| State | In-memory job/batch queue, persisted to `data/queue-state.json` | Stateless — one request drafts and sends one email |
| Pacing | Batches of jobs (`BATCH_SIZE`) with a long delay between batches, plus jitter between individual sends | A single server-enforced cooldown (`POST_SEND_COOLDOWN_MS`) between sends on the same warm instance |
| Progress | Poll `GET /api/status/:jobId` | Reads a newline-delimited JSON stream of phase events (`queued → drafting → drafted → sending → sent`) over one chunked HTTP response |
| Best for | Long-running hosts (Render, Railway, Fly.io, a VPS) where you're sending a batch of posts over time | Serverless/Vercel deployments |

Both paths call the same `services/cerebrasService.js` (drafting), `services/emailService.js` (sending), `services/emailExtractor.js` (recipient detection), and `services/draftSafety.js` (safety gate), so behavior can't silently drift between them.

## Project structure

```
server.js                    Express app: job queue, batching, persistence, all /api routes for Path A
api/send-outreach.js         Stateless streaming handler for Path B (Vercel)
config/profile.js            Resolves candidate profile: profile.json > env vars > built-in defaults
services/
  cerebrasService.js         Prompt construction + Groq API call, JSON parsing, retry logic, role classification
  emailService.js            Nodemailer transport, HTML/plain-text rendering, resume attachment, dry-run logging
  emailExtractor.js          Regex-based recipient email detection (plain / obfuscated / spaced formats)
  draftSafety.js             Shared pre-send safety check (placeholders, length, eligibility flag)
  groqRateLimiter.js         Sliding-window RPM/TPM limiter tuned to Groq's free-tier budget
persistence/store.js         Atomic JSON-file load/save for the job/batch queue (crash-safe restarts)
public/                      Frontend (index.html, css, js) — paste box, live status/progress UI
resume/                      Drop resume.pdf here (or point RESUME_PATH elsewhere)
data/                        Queue persistence + dry-run draft log (gitignored contents)
profile.example.json         Template for profile.json (per-candidate identity + fact sheets)
test/                        Node's built-in test runner: queue state machine, extractor, rate limiter, etc.
vercel.json                  Vercel config (60s max duration for the streaming function)
```

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```
2. **Add your resume** at `resume/resume.pdf` (or set `RESUME_PATH`).
3. **Set your identity.** Copy `profile.example.json` to `profile.json` in the repo root and fill in your name, contact links, degree/availability, and fact blocks (`techFacts`, `salesFacts`, `customerCareFacts`) — this is what the LLM is allowed to draw from when writing the proof paragraph. `profile.json` is gitignored; without it, `config/profile.js` falls back to individual env vars, then to built-in defaults.
4. **Set environment variables** (a `.env` file at the repo root, loaded via `dotenv`):

   | Variable | Required | Purpose |
   |---|---|---|
   | `GROQ_API_KEY` | Yes | Auth for the drafting LLM ([console.groq.com/keys](https://console.groq.com/keys)) |
   | `EMAIL_USER` | Yes | Gmail address to send from |
   | `EMAIL_APP_PASSWORD` | Yes | Gmail [App Password](https://myaccount.google.com/apppasswords) — not your normal password |
   | `GROQ_MODEL` | No | Overrides the default `openai/gpt-oss-20b` |
   | `GROQ_RPM_LIMIT` / `GROQ_TPM_LIMIT` | No | Adjust if your Groq plan's limits differ from the free tier |
   | `GROQ_DRAFT_MAX_ATTEMPTS` | No | Retries for transient drafting failures (default 3) |
   | `RESUME_PATH` | No | Override the resume file location |
   | `REPLY_TO_EMAIL` | No | Reply-To header (defaults to `EMAIL_USER`) |
   | `DRY_RUN` / `DRY_RUN_LOG_PATH` | No | Set `DRY_RUN=1` to write drafts to a local JSON file instead of sending real email |
   | `PROFILE_PATH` | No | Override the location of `profile.json` |
   | `PORT` | No | Server port for Path A (default 3000) |
   | `MIN_SEND_INTERVAL_MS`, `SEND_JITTER_MAX_MS`, `BATCH_SIZE`, `BATCH_DELAY_MS`, `ORPHAN_BATCH_TIMEOUT_MS` | No | Tune Path A's batching/pacing behavior |
   | `POST_SEND_COOLDOWN_MS` | No | Cooldown between sends for Path B (default 45s) |

   The server warns on startup (but still runs) if `GROQ_API_KEY`, `EMAIL_USER`, or `EMAIL_APP_PASSWORD` are missing; jobs will simply fail individually until they're set.

5. **Run it**
   ```bash
   npm start        # Path A: node server.js
   npm run dev       # Path A with --watch (auto-restart on file changes)
   ```
   Then open `http://localhost:3000`.

   For Path B, deploy to Vercel — `api/send-outreach.js` is picked up automatically as a serverless function per `vercel.json`.

## API (Path A — Express)

| Endpoint | Description |
|---|---|
| `POST /api/send-outreach` | Body: `{ postText, recipientEmail? }`. Queues a job, returns `{ jobId, status, position, etaSeconds, recipientEmail, emailAutoDetected }` (202). |
| `GET /api/status/:jobId` | Full job state including the draft once available. |
| `GET /api/jobs` | List recent jobs. |
| `POST /api/jobs/:jobId/retry` | Re-queues a job that ended in a failed/rejected status. |

Job status moves through a defined state machine (`queued → processing → drafting → waiting → sending → sent`, with `draft_failed` / `send_failed` / `send_unknown` / `rejected` as terminal failure states, each retryable back to `queued`).

## Testing

```bash
npm test
```
Runs Node's built-in test runner (`node --test`) over `test/`, covering the queue state machine, email extraction (including obfuscated-address edge cases), the Groq rate limiter, prompt/role classification, and send cooldown behavior.

## Notable design choices worth knowing about

- **`cerebrasService.js` calls Groq, not Cerebras.** The filename is a holdover from an earlier version of the project; the actual provider is Groq's OpenAI-compatible API.
- **The email transporter is deliberately unpooled** — a pooled Gmail SMTP connection can go stale and hang the next send until it times out, so a fresh connection is opened per send instead.
- **Queue state persists to a flat JSON file** (`persistence/store.js`), written atomically (temp file + rename) so a crash mid-write can't corrupt it. This is explicitly not built for multiple concurrent server instances.
- **Dry-run mode** (`DRY_RUN=1`) lets you review the first several AI-drafted emails on disk before any of them touch a real inbox.



## WhatsApp channel integration (Revised Plan)

The app supports `email`, `whatsapp`, and `both` per send. Following the **Revised Plan**, WhatsApp outreach is designed for on-demand manual use (~1 hour/day) rather than 24/7 background automation:
- **Direct on-demand send**: Senders trigger an immediate send to one contact at a time. There is no artificial queue or pacing delay.
- **Fixed greeting**: WhatsApp messages use a consistent, professional greeting without LLM generation.
- **Resume PDF attachment**: Transmits the candidate's resume (`resume/resume.pdf`) as a document attachment alongside the introductory message.
- **Lightweight deployment**: Can be run locally whenever outreach is needed (`cd whatsapp-service && npm start`), or on a Render free tier.

### Main app environment

Add:

| Variable | Purpose |
|---|---|
| `WHATSAPP_SERVICE_URL` | Base URL of the running WhatsApp service (e.g. `http://localhost:4000` or Render URL) |
| `WHATSAPP_API_KEY` | Shared secret used between the main app and service (`x-api-key`) |
| `WHATSAPP_API_TIMEOUT_MS` | Optional HTTP timeout for service calls |

### WhatsApp service environment

Copy `whatsapp-service/.env.example` to `whatsapp-service/.env` and set `WHATSAPP_API_KEY`.

Run it separately:

```bash
cd whatsapp-service
npm install
npm start
```

On startup, retrieve the QR from `/whatsapp/qr` and scan it from WhatsApp on your phone (Linked Devices → Link a Device).

The main app exposes:

- `POST /api/send-outreach` — accepts `channel`, `recipientPhone`, and `recipientEmail`; `whatsapp` sends fixed message + resume on demand; `both` personalizes email and sends WhatsApp directly.
- `GET /api/whatsapp/status` — returns session status and total sent count.
- `GET /api/whatsapp/qr` — proxies the pairing QR.

The microservice exposes `GET /whatsapp/qr`, `GET /whatsapp/status`, `POST /whatsapp/send`, `GET /whatsapp/history`, and `GET /healthz`.

> **Important:** `whatsapp-web.js` automates a personal WhatsApp Web session. Sending on demand to individual contacts for ~1 hour/day significantly minimizes automation flags. Test with your own number first before recruiter outreach.

## License

ISC (see `package.json`).
