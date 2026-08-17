import nodemailer from 'nodemailer';

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

// NOTE: we intentionally do NOT attach a PDF to a cold, unsolicited email.
// An attachment from an address the recipient has never emailed before is
// one of the strongest spam/phishing signals a filter looks for. Linking to
// the resume (Drive, portfolio, etc.) instead is much friendlier to
// deliverability, and the resume link is already woven into the email body
// by openrouterService.js — this file just sends what it's given.
export async function sendOutreachEmail({ to, subject, body }) {
  await getTransporter().sendMail({
    from: `"Jashan Singh" <${process.env.EMAIL_USER}>`,
    replyTo: process.env.EMAIL_USER,
    to,
    subject,
    text: body
  });
}
