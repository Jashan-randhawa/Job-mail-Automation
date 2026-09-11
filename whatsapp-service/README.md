# WhatsApp Outreach Microservice (Revised Plan)

Standalone Express service that sends WhatsApp messages and PDF attachments via [Baileys](https://github.com/WhiskeySockets/Baileys).
Following the **Revised Plan**, this service provides **on-demand, manual outreach** with a fixed greeting message and the candidate's resume PDF attachment, removing automated queue loops, delay pacing, and daily caps.

## Why a separate service

- Main app stays on Vercel for the web and email flow.
- This service runs as a persistent Node process (locally when sending or on a Render free tier) with Baileys' `useMultiFileAuthState` session persistence.
- The main app communicates with this service via HTTPS with an API key (`x-api-key`).

### Why Baileys and not whatsapp-web.js

This service originally used `whatsapp-web.js`, which drives a full headless Chromium via Puppeteer. On Render's free 512MB instance, Chromium's memory use during the initial post-scan chat sync reliably got the process OOM-killed before the session ever finished connecting, forcing an endless QR-regeneration loop. Baileys talks to WhatsApp over a plain WebSocket with no browser involved, which removes that memory spike entirely. Everything else about the service — endpoints, auth, persistence layout, deploy target — is unchanged.

## Setup & Running Locally

```bash
cd whatsapp-service
npm install
cp .env.example .env
# edit .env — set WHATSAPP_API_KEY to your secret
npm start
```

On first run:
1. Open `GET /whatsapp/qr` in a browser or through the main app UI.
2. Scan the QR code using WhatsApp on your phone (**Linked Devices** → **Link a Device**).
3. The session is saved to `WHATSAPP_SESSION_DIR` (`./data/wa-session`) and persists across runs.

## Endpoints

All endpoints require an `x-api-key` header matching `WHATSAPP_API_KEY` (except `/healthz`).

| Method | Path | Purpose |
|---|---|---|
| GET | `/whatsapp/qr` | Pairing QR (`qrDataUrl` is ready to render). `status` is `not_initialized` / `qr` / `connected`. |
| GET | `/whatsapp/status` | Connection state + total sent count + recent sends. |
| POST | `/whatsapp/send` | Body `{ "phone": "+919876543210", "message": "...", "attachResume": true }`. Sends directly on demand and returns the result immediately. |
| GET | `/whatsapp/history` | Log of previously messaged contacts (`sent-contacts.json`). |
| GET | `/healthz` | Health check endpoint. |

### Sending an Outreach Message

```bash
curl -X POST http://localhost:4000/whatsapp/send \
  -H "Content-Type: application/json" \
  -H "x-api-key: $WHATSAPP_API_KEY" \
  -d '{"phone": "+919876543210", "attachResume": true}'
```

- When `message` is omitted, the default professional greeting introducing the candidate is sent.
- When `attachResume` is true (default), the candidate's resume PDF (`resume/resume.pdf` or configured path) is delivered as an authentic document attachment.
- The phone number is recorded in `data/sent-contacts.json` so you can avoid messaging the same contact twice.
