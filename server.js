import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractConceptAndDraft } from './services/openrouterService.js';
import { sendOutreachEmail } from './services/emailService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Rapid-fire, evenly-spaced sends from a personal Gmail account read as
// script activity to Gmail's own abuse detection, which hurts deliverability
// for every send after it. This enforces a minimum gap between sends and
// adds a little jitter so the timing doesn't look mechanical.
const MIN_SEND_INTERVAL_MS = Number(process.env.MIN_SEND_INTERVAL_MS || 45_000);
let lastSendAt = 0;

app.post('/api/send-outreach', async (req, res) => {
  const { postText, recipientEmail } = req.body || {};

  if (!postText || !postText.trim()) {
    return res.status(400).json({ error: 'Paste the LinkedIn post text first.' });
  }
  if (!recipientEmail || !EMAIL_RE.test(recipientEmail)) {
    return res.status(400).json({ error: 'Enter a valid recipient email.' });
  }

  const sinceLastSend = Date.now() - lastSendAt;
  if (sinceLastSend < MIN_SEND_INTERVAL_MS) {
    const waitSec = Math.ceil((MIN_SEND_INTERVAL_MS - sinceLastSend) / 1000);
    return res.status(429).json({
      error: `Sending too fast looks like automation to Gmail. Wait ${waitSec}s before the next send.`
    });
  }

  let draft;
  try {
    draft = await extractConceptAndDraft(postText.trim());
  } catch (err) {
    console.error('OpenRouter step failed:', err);
    return res.status(502).json({ error: 'Could not generate a draft from that post. Try again.' });
  }

  const hasPlaceholder = /\[[^\]]{1,40}\]/.test(draft.subject || '') || /\[[^\]]{1,40}\]/.test(draft.body || '');
  const tooShort = !draft.body || draft.body.trim().length < 50;
  const missingSubject = !draft.subject || !draft.subject.trim();

  if (hasPlaceholder || tooShort || missingSubject) {
    console.error('Draft failed safety check — not sending.', draft);
    return res.status(422).json({
      error: 'Generated email failed the safety check (placeholder text, missing subject, or too short). Nothing was sent.',
      draft
    });
  }

  // Small random delay before actually sending — spreads out send timing
  // instead of firing the instant a draft is ready, another small nudge
  // away from looking like a script.
  const jitterMs = Math.floor(Math.random() * 20_000);
  await new Promise((resolve) => setTimeout(resolve, jitterMs));

  try {
    await sendOutreachEmail({ to: recipientEmail, subject: draft.subject, body: draft.body });
    lastSendAt = Date.now();
  } catch (err) {
    console.error('Send step failed:', err);
    return res.status(502).json({ error: 'Draft looked good but sending failed. Check your email credentials in .env.', draft });
  }

  res.json({ success: true, concept: draft.concept, subject: draft.subject, body: draft.body });
});

app.listen(PORT, () => {
  console.log(`LinkedIn outreach bot running at http://localhost:${PORT}`);
});
