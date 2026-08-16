# Job Mail Automation (LinkedIn Outreach Bot)

Paste a LinkedIn post and a recipient email. An LLM reads the post, drafts a
personalized outreach email, attaches your resume, and sends it — no review
step in between.

**Live:** [job-mail-automation-one.vercel.app](https://job-mail-automation-one.vercel.app/)

## How it works

1. You paste the post text + recipient email into the form.
2. An LLM (via OpenRouter — defaults to `openai/gpt-4.1-mini`, swappable to
   Claude, Gemini, Llama, or anything else on OpenRouter) extracts the
   concept — company, role, tech, whatever the post is actually about — and
   drafts a subject + body.
3. A safety gate checks the draft isn't empty, isn't suspiciously short, and
   has no leftover placeholder text (like `[Company]`). If it fails, nothing
   sends — you get the reason back instead.
4. If it passes, the email goes out via Gmail SMTP with your resume attached.

## Tech stack

- **Backend:** Node.js, Express 5
- **LLM:** OpenRouter (OpenAI-compatible API, model-agnostic)
- **Email:** Nodemailer via Gmail SMTP
- **Frontend:** Static HTML/JS (`public/index.html`), served by Express
- **Deployment:** Vercel (single serverless function serves both the API and the static frontend)

## Project structure

```
server.js                      Express app + the /api/send-outreach route
api/index.js                   Vercel serverless entrypoint (re-exports the Express app)
vercel.json                    Routes all requests to the serverless function
services/openrouterService.js  Prompt + call to OpenRouter, JSON parsing
services/emailService.js       Nodemailer transport + resume attachment
public/index.html              The form UI
resume/                        Put resume.pdf here
.env.example                   Copy to .env and fill in
```

## Local setup

**1. Install dependencies**
```
npm install
```

**2. Add your resume**

Drop your resume PDF into `resume/` and name it exactly `resume.pdf`.
(Or set `RESUME_PATH` in `.env` to point somewhere else.)

**3. Get an OpenRouter API key**

Free tier available at [openrouter.ai/keys](https://openrouter.ai/keys). Pick
any model from [openrouter.ai/models](https://openrouter.ai/models) and set
it as `OPENROUTER_MODEL`.

**4. Get a Gmail App Password**

Regular Gmail passwords don't work for SMTP anymore. You need:
- 2-Step Verification turned on for your Google account
- An App Password from [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
- Use that 16-character password, not your normal one

**5. Configure environment variables**
```
cp .env.example .env
```
Then fill in `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `EMAIL_USER`, and `EMAIL_APP_PASSWORD`.

**6. Run it**
```
npm start
```
Open [http://localhost:3000](http://localhost:3000).

## Deploying on Vercel

1. Push this repo to GitHub (`.env` stays out automatically via `.gitignore`).
2. Import the repo at [vercel.com/new](https://vercel.com/new). Framework preset: **Other** — no build step needed.
3. In Project Settings → Environment Variables, add `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `APP_URL`, `EMAIL_USER`, `EMAIL_APP_PASSWORD`.
4. Deploy. `api/index.js` + `vercel.json` handle routing everything (API and static frontend) through one serverless function.

## Notes

- **No review step, by design.** The safety gate is the only thing standing
  between a bad draft and a real recruiter's inbox — it blocks empty, too
  short, or placeholder-riddled drafts, but it can't catch a draft that's
  simply wrong in tone or fact. Worth spot-checking the `concept` and
  `subject` returned in the success message for the first several sends.
- **Gmail's sending limits** apply (roughly 500/day on a free account) —
  fine for personal outreach volume, not built for bulk sending.
- **Swap the sender profile** in `services/openrouterService.js` if your
  positioning changes — it's hardcoded there, not pulled from anywhere.
- **Model choice is a runtime setting** — change `OPENROUTER_MODEL` in `.env`
  (or the Vercel dashboard) without touching code.
