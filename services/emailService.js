import nodemailer from 'nodemailer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESUME_PATH = process.env.RESUME_PATH || path.join(__dirname, '..', 'resume', 'resume.pdf');

let transporter;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_APP_PASSWORD
      }
    });
  }
  return transporter;
}

// This is a real job application (not cold networking outreach), so an
// attached resume is expected rather than suspicious — most recruiters
// screen against an attachment first and may not click links, especially if
// their mail system strips them. The portfolio/GitHub/LinkedIn links stay in
// the signature as backup, but the PDF is the primary artifact here.
export async function sendOutreachEmail({ to, subject, body }) {
  const attachments = [];

  if (fs.existsSync(RESUME_PATH)) {
    attachments.push({
      filename: 'Jashanpreet_Singh_Resume.pdf',
      path: RESUME_PATH
    });
  } else {
    console.warn(`No resume found at ${RESUME_PATH} — sending without an attachment.`);
  }

  await getTransporter().sendMail({
    from: `"Jashanpreet Singh" <${process.env.EMAIL_USER}>`,
    replyTo: process.env.EMAIL_USER,
    to,
    subject,
    text: body,
    attachments
  });
}
