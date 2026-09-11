# WhatsApp Integration — Revised Plan

> **Status**: Supersedes the original 10-phase automation build plan for the WhatsApp channel.
> **Reason for change**: The original plan assumed WhatsApp would be a fully automated outreach channel (LLM-generated messages, paced queue, daily caps, retry/alerting infrastructure, 24/7 deployment). The actual need is much smaller and safer: **send one fixed greeting message plus the resume PDF, on demand, to one contact at a time**. No follow-up automation, no generated text, no scheduled sending.

---

## 1. What Changed

| Area | Original Plan | Revised Plan |
|---|---|---|
| **Message Content** | LLM-generated, WhatsApp-flavored prompt variant | One fixed greeting message, same every time, no LLM involved |
| **Sending Trigger** | Queue worker, paced automatically alongside email jobs | Manual, on-demand — triggered instantly when wanted |
| **Volume / Frequency** | ~20–40/day, randomized 30–90s delays, daily caps | ~1 hour of occasional use per day; no queue, no pacing needed |
| **Attachment** | Not part of original scope | Candidate resume PDF (`resume/resume.pdf`) sent alongside the text message |
| **Retry & Alerting** | Exponential backoff, webhook alerting on session drop | Not needed — failed manual send returns immediate error and is retried by hand |
| **Data Model** | Full job lifecycle tracked per contact | Lightweight persisted log (`sent-contacts.json`) of contacts who received the greeting |
| **Deployment** | Always-on microservice, persistent disk, Render/Railway | Light-use only: run locally when needed, or daily QR re-scan on Render free tier |

---

## 2. What Stays from the Existing Build

The `whatsapp-service` (`whatsapp-web.js` + `LocalAuth` session + QR pairing) remains the foundation:
- Express microservice skeleton and `whatsappClient.js` session handling
- `LocalAuth` with `WHATSAPP_SESSION_DIR` for session persistence
- QR pairing flow (`GET /whatsapp/qr`, behind `x-api-key` check)
- `x-api-key` auth pattern for all endpoints

---

## 3. Resume PDF Attachment Support

`whatsapp-web.js`'s `MessageMedia` is used to load and send documents:
- Resolves the candidate's PDF from `RESUME_PATH` or default `resume/resume.pdf`
- Attaches the document with candidate filename `Jashanpreet_Singh_Resume.pdf`
- Transmitted as an authentic document attachment alongside the introductory greeting message

---

## 4. Endpoints

- `GET /whatsapp/qr` — Get current QR pairing data URL / string.
- `GET /whatsapp/status` — Returns session status, connected boolean, total sent count, and recent sends.
- `POST /whatsapp/send` — Accepts `{ phone, message?, attachResume? }` and sends immediately on-demand.
- `GET /whatsapp/history` — Returns sent contacts log.
- `GET /healthz` — Health check endpoint.
