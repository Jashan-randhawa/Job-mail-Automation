# ⚡ Job Mail & WhatsApp Automation

<div align="center">

![GitHub repo size](https://img.shields.io/github/repo-size/Jashan-randhawa/Job-mail-Automation?style=for-the-badge&logo=github&color=blue)
![Version](https://img.shields.io/badge/version-1.4.1-blue?style=for-the-badge)
![Node.js Version](https://img.shields.io/badge/Node.js-v18%2B%20%7C%20ESM-339933?style=for-the-badge&logo=node.js&logoColor=white)
![Express Version](https://img.shields.io/badge/Express-5.x-000000?style=for-the-badge&logo=express&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-GHCR%20Images-2496ED?style=for-the-badge&logo=docker&logoColor=white)
![npm](https://img.shields.io/badge/npm-CLI%20%26%20Package-CB3837?style=for-the-badge&logo=npm&logoColor=white)
![Groq](https://img.shields.io/badge/Groq%20Cloud-Ultra--Fast%20LLM-F55036?style=for-the-badge&logo=groq&logoColor=white)
![WhatsApp](https://img.shields.io/badge/WhatsApp-Baileys%20WebSocket-25D366?style=for-the-badge&logo=whatsapp&logoColor=white)
![Wiki](https://img.shields.io/badge/docs-GitHub%20Wiki-informational?style=for-the-badge&logo=github)

<br />

**Autonomous, fact-grounded multichannel recruiter outreach bot powered by Groq LLMs, unpooled Gmail SMTP, and Baileys WhatsApp automation.**

[Key Highlights](#-key-highlights) • [Architecture](#-system-architecture) • [Quickstart](#-quickstart--setup) • [Docker Compose](#option-a-docker-compose-recommended) • [CLI Executable](#option-c-cli-executable--npx) • [Configuration](#-configuration--environment-variables) • [API Reference](#-api-reference) • [Safety & Anti-Ban](#-safety-gates--anti-ban-measures) • [Official Wiki](https://github.com/Jashan-randhawa/Job-mail-Automation/wiki)

</div>

---

## 🚀 Overview

**Job Mail & WhatsApp Automation** transforms raw LinkedIn hiring posts into personalized, high-converting recruiter outreach in seconds. Instead of generic mass-spamming or manual copy-pasting:

1. **Instant Extraction:** Ingests raw LinkedIn posts, automatically detecting direct and obfuscated recruiter emails (`[at]`, `(at)`, `[dot]`, spaced strings) or target phone numbers.
2. **Fact-Grounded LLM Drafting:** Leverages Groq's high-throughput LLM (`openai/gpt-oss-20b` or custom models) to classify the job (Tech, Sales, Support, Hybrid) and selectively pull matching facts from your structured profile.
3. **Resilient Retry Loop:** Automatically recovers from Groq JSON object schema validation failures (`400`), rate limits (`429`), and `5xx` server hiccups via jittered backoff (`GROQ_DRAFT_MAX_ATTEMPTS`).
4. **Strict Safety Gates:** Discards drafts containing hallucinated tokens, placeholder brackets (`[Company]`), eligibility mismatches, or missing subject lines before outreach triggers.
5. **Multichannel Delivery:** Delivers personalized emails via Gmail SMTP with your PDF resume attached, or transmits a personalized WhatsApp greeting + resume PDF on-demand through an authenticated Baileys WhatsApp session.
6. **Deploy Anywhere:** Run as an orchestrated multi-container Docker Compose stack, standalone CLI executable via NPX, persistent Express server, or serverless Vercel edge app.

---

## ✨ Key Highlights

<table>
  <tr>
    <td width="50%">
      <h3>📧 Smart Email Pipeline</h3>
      <ul>
        <li><b>De-obfuscating Parser:</b> Catches <code>hr [at] company [dot] com</code>, spaced characters, and standard regex formats.</li>
        <li><b>Dynamic Fact Mapping:</b> Matches job domain with your custom <code>techFacts</code>, <code>salesFacts</code>, or <code>customerCareFacts</code>.</li>
        <li><b>Unpooled Nodemailer:</b> Dedicated, fresh SMTP handshakes to prevent stale connection hang-ups on Gmail.</li>
        <li><b>Dry-Run Auditing:</b> Test prompts and view output drafts saved to JSON without firing actual emails.</li>
      </ul>
    </td>
    <td width="50%">
      <h3>💬 WhatsApp Microservice</h3>
      <ul>
        <li><b>Baileys Socket Integration:</b> Pure WebSocket protocol with persistent auth credentials (no heavy Chromium RAM bloat).</li>
        <li><b>Direct QR Onboarding:</b> Terminal and HTTP-streamed QR pairing via <code>/whatsapp/qr</code>.</li>
        <li><b>Document Transmission:</b> Automatically uploads and pairs candidate PDF resumes with the initial message.</li>
        <li><b>Humanized On-Demand Send:</b> Zero artificial queue delays during targeted 1-on-1 recruiter outreach sessions.</li>
      </ul>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <h3>🛡️ Autonomous Safety & Integrity</h3>
      <ul>
        <li><b>Eligibility Guard:</b> If a post requires protected criteria or specific credentials not met in your profile, outreach skips gracefully.</li>
        <li><b>Placeholder Interceptor:</b> Never send embarrassing <code>[Hiring Manager Name]</code> or <code>[Company]</code> placeholders.</li>
        <li><b>Groq Token Rate Limiter:</b> Sliding-window RPM & TPM tracker customized for Groq free/tier budgets.</li>
        <li><b>Server-Side Cooldown:</b> Enforces <code>POST_SEND_COOLDOWN_MS</code> (45s) on Vercel to prevent rapid burst abuse.</li>
      </ul>
    </td>
    <td width="50%">
      <h3>⚡ Resilient Architecture & Packaging</h3>
      <ul>
        <li><b>Docker Compose Ready:</b> Multi-container stack pre-configured with volume mounts and internal DNS bridge.</li>
        <li><b>GitHub Container Registry:</b> Automated OCI image builds pushed to <code>ghcr.io</code> on every release.</li>
        <li><b>CLI Executable & Exports:</b> Published to GitHub Packages with runnable <code>job-mail-automation</code> bin and modular library imports.</li>
        <li><b>Crash-Resilient State:</b> In-memory queue state is persisted atomically via temporary file writes & POSIX renames.</li>
      </ul>
    </td>
  </tr>
</table>

---

## 🏗️ System Architecture

```mermaid
flowchart TB
    subgraph Client["Frontend Dashboard / API Client"]
        UI["Web Dashboard (Vanilla JS + CSS)"]
        CLI["CLI Tool / NPX Executable"]
        Curl["External Webhook / Script"]
    end

    subgraph Runtime["Dual Runtime Entrypoints"]
        direction TB
        PathA["Path A: Express Server (server.js)<br/>• In-Memory Batch Queue<br/>• Atomic File Persistence<br/>• Human Pacing & Jitter"]
        PathB["Path B: Vercel Serverless (api/send-outreach.js)<br/>• Stateless One-Shot<br/>• NDJSON Event Stream<br/>• Warm Instance Cooldown"]
    end

    subgraph Core["Core Intelligence & Extraction Engine"]
        Extractor["Regex Email Extractor<br/>(emailExtractor.js)"]
        Classifier["Groq LLM Engine & Classifier<br/>(cerebrasService.js)"]
        RetryLoop["Jittered Retry Loop<br/>(GROQ_DRAFT_MAX_ATTEMPTS)"]
        Safety["Pre-Send Safety Gate<br/>(draftSafety.js)"]
        Profile["Profile Resolver<br/>(profile.json > env > defaults)"]
    end

    subgraph Channels["Outreach Delivery Channels"]
        EmailService["Email Dispatcher (emailService.js)<br/>• Fresh Gmail SMTP<br/>• Resume Attachment<br/>• HTML / Plaintext"]
        WAService["WhatsApp Microservice (whatsapp-service/)<br/>• Baileys Socket Session<br/>• Resume Document Send<br/>• QR Auth / Status API"]
    end

    UI -->|POST /api/send-outreach| Runtime
    CLI -->|POST /api/send-outreach| Runtime
    Curl -->|POST /api/send-outreach| Runtime

    Runtime --> Extractor
    Extractor --> Classifier
    Classifier --> RetryLoop
    Profile --> Classifier
    RetryLoop --> Safety
    
    Safety -->|Channel: Email / Both| EmailService
    Safety -->|Channel: WhatsApp / Both| WAService

    EmailService --> RecipientEmail[("Recruiter Inbox (Gmail SMTP)")]
    WAService --> RecipientWA[("Recruiter WhatsApp (Baileys)")]
```

---

## ⚖️ Two Execution Paths

Choose the execution model that fits your infrastructure:

| Feature | Path A: Express Server (`server.js`) | Path B: Serverless Function (`api/send-outreach.js`) |
| :--- | :--- | :--- |
| **Ideal Environment** | Long-running servers (Docker Compose, VPS, Render, Railway, Localhost) | Cloudflare, AWS Lambda, Vercel Serverless |
| **State Management** | In-memory job queue persisted atomically to `data/queue-state.json` | 100% Stateless — single invocation per outreach |
| **Pacing Strategy** | Batched groups (`BATCH_SIZE`) with large batch delays + randomized jitter | Strict server-enforced cooldown (`POST_SEND_COOLDOWN_MS`) |
| **Progress Reporting** | Pollable state transitions via `GET /api/status/:jobId` and `GET /api/jobs` | Real-time NDJSON stream (`queued → drafting → drafted → sending → sent`) |
| **Queue Resilience** | Restores unprocessed and active jobs automatically after unexpected restarts | Not applicable (lifecycle ends when HTTP response finishes) |

---

## 📂 Project Structure

```bash
Job-mail-Automation/
├── server.js                     # Main Express server: queue, batching, state machine, API routes, CLI bin
├── Dockerfile                    # Container definition for main backend service (GHCR publish)
├── docker-compose.yml            # Multi-container orchestration (backend:3000 + whatsapp-service:4000)
├── api/
│   ├── send-outreach.js          # Stateless Vercel serverless streaming handler (Path B)
│   ├── whatsapp-status.js        # Serverless WhatsApp status proxy
│   └── whatsapp/                 # QR and status proxy routes
├── config/
│   └── profile.js                # Profile manager (profile.json > process.env > defaults)
├── services/
│   ├── cerebrasService.js        # Groq LLM integration, prompt engineering, role classifier, retry loop
│   ├── emailService.js           # Nodemailer transport, unpooled Gmail SMTP, HTML rendering
│   ├── emailExtractor.js         # Extraction regex for plain, obfuscated, and spaced emails
│   ├── draftSafety.js            # Pre-send validation (placeholders, length, eligibility)
│   ├── groqRateLimiter.js        # Sliding-window RPM/TPM limiter for Groq APIs
│   └── whatsappService.js       # Main app client & proxy for WhatsApp microservice
├── persistence/
│   └── store.js                  # Atomic JSON store (temp write + rename) for queue state
├── public/                       # Frontend web dashboard
│   ├── index.html                # Modern UI with outreach input, QR viewer & channel toggles
│   ├── css/style.css             # Glassmorphic responsive styling
│   └── js/                       # Stream reader, status poller, and QR preview logic
├── resume/
│   └── resume.pdf                # Candidate PDF resume (attached to emails and WhatsApp)
├── data/                         # Local persistence (gitignored queue state & dry-run logs)
├── profile.example.json          # Starter template for candidate background & facts
├── whatsapp-service/             # Dedicated WhatsApp microservice
│   ├── server.js                 # Express server with Baileys socket integration (port 4000)
│   ├── Dockerfile                # Container definition for WhatsApp microservice
│   ├── railway.json              # Railway deployment manifest
│   ├── render.yaml               # Render Infrastructure-as-Code deployment specification
│   ├── services/
│   │   ├── whatsappClient.js     # Baileys connection handler, QR generator, message dispatcher
│   │   └── whatsappPolicy.js     # Phone validator & default greeting templates
│   ├── persistence/              # Local storage for sent contacts and Baileys session keys
│   └── package.json              # Microservice manifest (@jashan-randhawa/whatsapp-outreach-service)
├── .github/workflows/
│   ├── docker-publish.yml        # Multi-arch Docker build & push to GitHub Container Registry
│   └── npm-publish.yml           # Automated package publishing to GitHub Packages
├── test/                         # Native Node.js test suite
├── vercel.json                   # Vercel serverless runtime configuration
└── package.json                  # Root project manifest & CLI definition (ES Modules)
```

---

## 🚀 Quickstart & Setup

### 1. Prerequisites
- **Node.js**: v18.0.0 or higher (Node 20+ recommended) or **Docker & Docker Compose**
- **Gmail Account**: With [2-Step Verification](https://myaccount.google.com/signinoptions/two-step-verification) enabled
- **Groq Cloud Account**: For ultra-fast inference ([console.groq.com](https://console.groq.com))
- **WhatsApp Account**: On a secondary or active phone for pairing

### 2. Configure Profile & Resume
1. Copy the example profile template:
   ```bash
   cp profile.example.json profile.json
   ```
2. Edit `profile.json` with your real background facts, contact details, and achievements.
3. Save your resume PDF as `resume/resume.pdf` (or configure `RESUME_PATH`).

---

### Option A: Docker Compose (Recommended)

Start the entire multi-service stack with a single command:

```bash
docker compose up -d
```

- **Web Dashboard**: Open `http://localhost:3000`
- **WhatsApp Microservice**: Running on port `4000`
- **Volumes**: `./data`, `./whatsapp-service/data`, and `./resume` are mounted automatically.

To pair WhatsApp:
1. Open `http://localhost:3000` to view the QR code in the dashboard, or open `http://localhost:4000/whatsapp/qr`.
2. Scan the QR code using WhatsApp on your phone (**Settings > Linked Devices > Link a Device**).

To shut down:
```bash
docker compose down
```

---

### Option B: Local Node.js Development

```bash
# 1. Clone repository
git clone https://github.com/Jashan-randhawa/Job-mail-Automation.git
cd Job-mail-Automation

# 2. Install dependencies
npm install
cd whatsapp-service && npm install && cd ..

# 3. Configure root .env
cp .env.example .env # edit with your GROQ_API_KEY, EMAIL_USER, EMAIL_APP_PASSWORD

# 4. Start WhatsApp Microservice (Terminal 1)
cd whatsapp-service
npm start

# 5. Start Main Backend Server (Terminal 2)
npm run dev
```

Open `http://localhost:3000` in your browser.

---

### Option C: CLI Executable / NPX

The package is published as an executable command on GitHub Packages:

```bash
# Run directly via npx
npx @jashan-randhawa/job-mail-automation

# Or install globally
npm install -g @jashan-randhawa/job-mail-automation
job-mail-automation
```

---

## ⚙️ Configuration & Environment Variables

### Root Application (`server.js` & `api/send-outreach.js`)

| Variable | Type | Default | Description |
| :--- | :---: | :---: | :--- |
| `GROQ_API_KEY` | `string` | **Required** | Groq Cloud API authentication key |
| `EMAIL_USER` | `string` | **Required** | Gmail address used for sending applications |
| `EMAIL_APP_PASSWORD` | `string` | **Required** | 16-character Google App Password |
| `GROQ_MODEL` | `string` | `openai/gpt-oss-20b` | Groq LLM model identifier |
| `GROQ_DRAFT_MAX_ATTEMPTS` | `number` | `3` | Automatic retry attempts for Groq schema errors (400) and rate limits (429) |
| `GROQ_RPM_LIMIT` | `number` | `30` | Requests per minute budget |
| `GROQ_TPM_LIMIT` | `number` | `6000` | Tokens per minute budget (adjust for paid tiers) |
| `PORT` | `number` | `3000` | Local HTTP port for Express |
| `RESUME_PATH` | `string` | `./resume/resume.pdf` | Path to PDF resume |
| `REPLY_TO_EMAIL` | `string` | `EMAIL_USER` | Optional alternative reply-to email |
| `DRY_RUN` | `string/number` | `0` | If `1` or `true`, writes drafts to disk instead of sending |
| `BATCH_SIZE` | `number` | `3` | Number of jobs per dispatch batch (Path A) |
| `BATCH_DELAY_MS` | `number` | `2700000` (45m) | Delay between outgoing batches |
| `MIN_SEND_INTERVAL_MS` | `number` | `45000` (45s) | Minimum pacing delay between individual sends |
| `SEND_JITTER_MAX_MS` | `number` | `20000` (20s) | Max random jitter added to send intervals |
| `POST_SEND_COOLDOWN_MS` | `number` | `45000` (45s) | Server-side cooldown delay for Path B |
| `WHATSAPP_SERVICE_URL` | `string` | `http://localhost:4000` | URL of the running WhatsApp microservice (in Docker: `http://whatsapp-service:4000`) |
| `WHATSAPP_API_KEY` | `string` | `""` | Shared security secret for microservice calls |

### WhatsApp Microservice (`whatsapp-service/`)

| Variable | Type | Default | Description |
| :--- | :---: | :---: | :--- |
| `PORT` | `number` | `4000` | Microservice server port |
| `WHATSAPP_API_KEY` | `string` | **Required** | Header `x-api-key` required for all endpoints |
| `WHATSAPP_SESSION_DIR` | `string` | `./data/wa-session` | Directory where Baileys authentication keys are persisted |
| `WHATSAPP_PERSIST_PATH` | `string` | `./data/sent-contacts.json` | Path to log of contacted numbers |
| `RESUME_ATTACHMENT_FILENAME` | `string` | `Jashanpreet_Singh_Resume.pdf` | Filename presented when attaching resume |
| `WHATSAPP_WATCHDOG_STALL_MS` | `number` | `180000` (3m) | Threshold for self-exit recovery during stalled sockets |

---

## 📡 API Reference

### 1. Outreach Dispatch
```http
POST /api/send-outreach
```
**Request Body:**
```json
{
  "postText": "We are looking for a Full Stack Developer! Reach out to us at hiring@techcorp.io or +1234567890",
  "recipientEmail": "hiring@techcorp.io",
  "recipientPhone": "+1234567890",
  "channel": "both"
}
```
*Channels: `"email"` (default), `"whatsapp"`, or `"both"`.*

**Response (HTTP 202 Accepted):**
```json
{
  "jobId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "status": "queued",
  "channel": "both",
  "recipientEmail": "hiring@techcorp.io",
  "recipientPhone": "+1234567890",
  "emailAutoDetected": false
}
```

---

### 2. Job Queue & Status

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/status/:jobId` | Retrieve full job state, draft details, timestamps, and error logs |
| `GET` | `/api/jobs` | List recent jobs and their current execution statuses |
| `POST` | `/api/jobs/:jobId/retry` | Re-enqueue a failed or rejected job |

#### Job State Lifecycle:
```
queued ──► processing ──► drafting ──► waiting ──► sending ──► sent
   │            │            │            │           │
   ▼            ▼            ▼            ▼           ▼
rejected   draft_failed  draft_failed  send_failed  send_failed / send_unknown
```

---

### 3. WhatsApp Microservice Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/whatsapp/status` | Microservice connectivity status and total message count |
| `GET` | `/whatsapp/qr` | Get current base64 QR code for mobile pairing |
| `POST` | `/whatsapp/send` | Send direct greeting and resume PDF to `{ phone, message?, attachResume? }` |
| `GET` | `/whatsapp/history` | Log of previously messaged contacts |
| `GET` | `/healthz` | Public liveness probe returning `{"ok": true}` |

---

## 🛡️ Safety Gates & Anti-Ban Measures

Mass automated messaging violates carrier and platform terms of service. This project employs strict structural safeguards:

### WhatsApp Compliance
- **On-Demand Single Dispatches:** Designed for active 1-on-1 recruiter outreach sessions (~1 hour/day), avoiding unattended spam bots.
- **Fixed Polite Greeting:** Outreach messages avoid manipulative or deceptive clickbait language.
- **Direct PDF Attaching:** Transmits the resume document cleanly rather than sending spammy external file links.
- **Duplicate Prevention:** Tracks messaged numbers in `sent-contacts.json` to prevent accidental multi-messaging.

### Email Deliverability
- **Humanized Jitter & Pacing:** Inter-send delays of 45-65s and inter-batch pauses of 45+ minutes keep send volumes well under Google SMTP thresholds.
- **Unpooled Connections:** Ensures every email creates a clean TLS handshake, eliminating connection reuse timeouts.
- **Pre-Send Draft Validation:** Blocks empty drafts, excessive brevity (<50 characters), or leftover template brackets (`[Your Name]`, `[Company]`).

---

## 🧪 Testing

Run the comprehensive unit and integration test suite via Node's native test runner:

```bash
npm test
```

Covers:
- `test/cerebrasServiceRetry.test.js`: Mocking Groq client for schema validation failures, 503 recovery, retry exhaustion, and non-retryable 401 errors.
- `test/sendOutreachCooldown.test.js`: Validating server-side Path B cooldown enforcement.
- `test/emailExtractor.test.js`: Obfuscated email syntax (`[at]`, `[dot]`, spacing, invalid patterns).
- `test/groqRateLimiter.test.js`: Window sliding and rate pacing limits.
- `test/queue.test.js`: Transition guarantees, state persistence, and error recovery.

---

## 📖 Complete Documentation Wiki

For detailed architecture guides, environment variable references, troubleshooting FAQs, and deep dive tutorials, visit the **[Job Mail & WhatsApp Automation Official Wiki](https://github.com/Jashan-randhawa/Job-mail-Automation/wiki)**.

---

## 📄 License

This project is open source and available under the [ISC License](package.json).

---

<div align="center">
  <sub>Developed with precision by <a href="https://github.com/Jashan-randhawa">Jashanpreet Singh</a></sub>
</div>
