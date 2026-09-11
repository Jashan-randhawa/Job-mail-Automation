import test from 'node:test';
import assert from 'node:assert/strict';
import { checkDraftSafety } from '../services/draftSafety.js';

test('WhatsApp safety does not require an email subject', () => {
  const result = checkDraftSafety({
    subject: null,
    body: 'Hi, I saw your post about the frontend role and would love to discuss how my experience could help your team.'
  }, { channel: 'whatsapp' });
  assert.equal(result.rejected, false);
});

test('Email safety still requires a subject', () => {
  const result = checkDraftSafety({
    subject: null,
    body: 'Hi, I saw your post about the frontend role and would love to discuss how my experience could help your team.'
  });
  assert.equal(result.rejected, true);
});
