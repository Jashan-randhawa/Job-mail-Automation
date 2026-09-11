// Covers the retry loop added to services/cerebrasService.js around the
// Groq draft call: retryable errors (Groq's own json_object schema
// validation failures, rate limits, 5xx, timeouts) get retried a few times
// with backoff; anything else fails immediately, same as before.
//
// Mocks the `openai` package itself, so no real network call or API key is
// needed. Requires `--experimental-test-module-mocks` (see package.json's
// `test` script).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';

process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test-key';

// Swapped between test cases; the fake OpenAI client's `create` always
// delegates to whatever this currently points at.
let currentCreateImpl;

mock.module('openai', {
  defaultExport: class FakeOpenAI {
    constructor() {
      this.chat = { completions: { create: (...args) => currentCreateImpl(...args) } };
    }
  }
});

const { extractConceptAndDraft } = await import('../services/cerebrasService.js');

function validCompletion(overrides = {}) {
  return {
    choices: [{
      message: {
        content: JSON.stringify({
          roleCategory: 'TECHNICAL',
          eligibilityFlag: null,
          concept: 'Backend engineer role at Acme',
          subject: 'Application for Backend Engineer',
          body: 'Dear Hiring Manager,\n\nThe post\'s focus on backend systems resonated with my experience.\n\nI built and shipped a service that improved throughput by 40%.\n\nI am a 2026 B.S. Computer Science graduate, available to start immediately and open to interview at your convenience.\n\nI would appreciate the opportunity to discuss how my background in backend engineering and system design can support your team, with my resume and portfolio attached for full details.\n\nSincerely,\n\nCandidate',
          ...overrides
        })
      }
    }],
    usage: { total_tokens: 500 }
  };
}

function groqError(message, status) {
  const err = new Error(message);
  if (status != null) err.status = status;
  return err;
}

test('retries once on a Groq json_object schema-validation failure, then succeeds', async () => {
  let calls = 0;
  currentCreateImpl = async () => {
    calls += 1;
    if (calls === 1) {
      throw groqError("400 Failed to validate JSON. Please adjust your prompt. See 'failed_generation' for more details.", 400);
    }
    return validCompletion();
  };

  const draft = await extractConceptAndDraft('We are hiring a backend engineer. Email hr@acme.com to apply.');
  assert.equal(calls, 2, 'should have retried exactly once');
  assert.equal(draft.subject, 'Application for Backend Engineer');
});

test('retries on a 503 from Groq, then succeeds', async () => {
  let calls = 0;
  currentCreateImpl = async () => {
    calls += 1;
    if (calls < 3) throw groqError('503 Service Unavailable', 503);
    return validCompletion();
  };

  const draft = await extractConceptAndDraft('We are hiring a backend engineer. Email hr@acme.com to apply.');
  assert.equal(calls, 3, 'should have retried twice before succeeding on the third attempt');
  assert.equal(draft.roleCategory, 'TECHNICAL');
});

test('gives up after the max attempts on a persistently retryable error', async () => {
  let calls = 0;
  currentCreateImpl = async () => {
    calls += 1;
    throw groqError('503 Service Unavailable', 503);
  };

  await assert.rejects(() => extractConceptAndDraft('post text'), /503/);
  assert.equal(calls, 3, 'default MAX_DRAFT_ATTEMPTS is 3 — should not retry a 4th time');
});

test('does not retry a non-retryable error (e.g. bad API key)', async () => {
  let calls = 0;
  currentCreateImpl = async () => {
    calls += 1;
    throw groqError('401 Unauthorized: invalid API key', 401);
  };

  await assert.rejects(() => extractConceptAndDraft('post text'), /401/);
  assert.equal(calls, 1, 'a non-retryable error should fail immediately, no retries');
});

test('does not retry a draft missing subject/body more than the max attempts, and still eventually throws', async () => {
  let calls = 0;
  currentCreateImpl = async () => {
    calls += 1;
    // Missing "subject" — parseDraftResponse succeeds but our own
    // validation throws "Groq response was missing subject or body.",
    // which IS treated as retryable (the model may just do better next
    // time), but should still give up after MAX_DRAFT_ATTEMPTS.
    return validCompletion({ subject: '' });
  };

  await assert.rejects(() => extractConceptAndDraft('post text'), /missing subject or body/i);
  assert.equal(calls, 3);
});
