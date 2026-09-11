import test from 'node:test';
import assert from 'node:assert/strict';
import { __queueTest, queueConfig } from '../server.js';

function configure() {
  __queueTest.reset();
  queueConfig.minSendIntervalMs = 0;
  queueConfig.jitterMaxMs = 0;
  queueConfig.batchSize = 1; // this file tests email detection, not batching — keep old immediate-eligibility behavior
  queueConfig.batchDelayMs = 0;
  __queueTest.setServices({
    extractConceptAndDraft: async (postText) => ({
      concept: 'concept',
      subject: 'Application',
      body: 'Hello team, this is a detailed and safe application email body with enough length for validation. Regards.'
    }),
    sendOutreachEmail: async () => {}
  });
}

async function postOutreach(body) {
  const { app } = await import('../server.js');
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/api/send-outreach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return { status: response.status, json: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('send-outreach auto-detects the recipient email from the post when the field is left blank', async () => {
  configure();
  const { status, json } = await postOutreach({
    postText: 'We are hiring a backend engineer. Send your resume to hr@acme.com to apply.',
    recipientEmail: ''
  });
  assert.equal(status, 202);
  assert.equal(json.recipientEmail, 'hr@acme.com');
  assert.equal(json.emailAutoDetected, true);
  const job = __queueTest.jobs.get(json.jobId);
  assert.equal(job.recipientEmail, 'hr@acme.com');
});

test('send-outreach prefers an explicitly-provided valid email over auto-detection', async () => {
  configure();
  const { status, json } = await postOutreach({
    postText: 'We are hiring! Send your resume to hr@acme.com to apply.',
    recipientEmail: 'manual@example.com'
  });
  assert.equal(status, 202);
  assert.equal(json.recipientEmail, 'manual@example.com');
  assert.equal(json.emailAutoDetected, false);
});

test('send-outreach still errors when no email is provided and none can be detected', async () => {
  configure();
  const { status, json } = await postOutreach({
    postText: 'We are hiring a backend engineer. DM us on LinkedIn to apply.',
    recipientEmail: ''
  });
  assert.equal(status, 400);
  assert.match(json.error, /valid recipient email/i);
});

test('send-outreach auto-detects an obfuscated email from the post', async () => {
  configure();
  const { status, json } = await postOutreach({
    postText: 'Apply by emailing jobs [at] acme [dot] com with your CV.',
    recipientEmail: ''
  });
  assert.equal(status, 202);
  assert.equal(json.recipientEmail, 'jobs@acme.com');
  assert.equal(json.emailAutoDetected, true);
});
