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

export async function sendOutreachEmail({ to, subject, body }) {
  const attachments = [];

  if (fs.existsSync(RESUME_PATH)) {
    attachments.push({
      filename: 'Jashan_Singh_Resume.pdf',
      path: RESUME_PATH
    });
  } else {
    console.warn(`No resume found at ${RESUME_PATH} — sending without an attachment.`);
  }

  await getTransporter().sendMail({
    from: `"Jashan Singh" <${process.env.EMAIL_USER}>`,
    to,
    subject,
    text: body,
    attachments
  });
}
