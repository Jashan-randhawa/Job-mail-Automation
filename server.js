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

app.post('/api/send-outreach', async (req, res) => {
  const { postText, recipientEmail } = req.body || {};

  if (!postText || !postText.trim()) {
    return res.status(400).json({ error: 'Paste the LinkedIn post text first.' });
  }
  if (!recipientEmail || !EMAIL_RE.test(recipientEmail)) {
    return res.status(400).json({ error: 'Enter a valid recipient email.' });
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

  try {
    await sendOutreachEmail({ to: recipientEmail, subject: draft.subject, body: draft.body });
  } catch (err) {
    console.error('Send step failed:', err);
    return res.status(502).json({ error: 'Draft looked good but sending failed. Check your email credentials in .env.', draft });
  }

  res.json({ success: true, concept: draft.concept, subject: draft.subject, body: draft.body });
});

app.listen(PORT, () => {
  console.log(`LinkedIn outreach bot running at http://localhost:${PORT}`);
});
