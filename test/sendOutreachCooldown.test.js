// Covers the server-side pacing added to api/send-outreach.js (Path B).
// Unlike test/sendOutreachEmailDetection.test.js (which exercises Path A's
// Express app over real HTTP), this calls the Vercel-style handler directly
// with fake req/res objects, and mocks out the Groq draft + Gmail send calls
// so the test is fast and needs no real credentials.
//
// Requires `--experimental-test-module-mocks` (see package.json's `test`
// script) for `mock.module`.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

function makeRes() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    written: [],
    ended: false,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); },
    write(chunk) { this.written.push(chunk); },
    end() { this.ended = true; }
  };
}

function events(res) {
  return res.written.map((line) => JSON.parse(line));
}

test('Path B (api/send-outreach.js) server-side send cooldown', async (t) => {
  // Read once at module load, so set it before importing the handler.
  process.env.POST_SEND_COOLDOWN_MS = '200';

  mock.module('../services/cerebrasService.js', {
    namedExports: {
      extractConceptAndDraft: async () => ({
        concept: 'Backend engineer role at Acme',
        subject: 'Application for Backend Engineer',
        body: 'Hello team, this is a detailed and safe application email body with enough length to pass the safety check. Regards.'
      })
    }
  });
  mock.module('../services/emailService.js', {
    namedExports: {
      sendOutreachEmail: async () => {}
    }
  });

  const { default: handler } = await import('../api/send-outreach.js');
  const makeReq = (postText) => ({ method: 'POST', body: { postText, recipientEmail: '' } });

  await t.test('first send goes through immediately', async () => {
    const res = makeRes();
    await handler(makeReq('We are hiring! Send your resume to hr@acme.com to apply.'), res);
    assert.equal(res.statusCode, 200);
    assert.equal(events(res).at(-1).phase, 'sent');
  });

  await t.test('a send attempted immediately after is rejected with 429 + retryAfterMs, no draft call made', async () => {
    const res = makeRes();
    await handler(makeReq('Second post, mail hr@acme.com to apply.'), res);
    assert.equal(res.statusCode, 429);
    assert.ok(res.body.retryAfterMs > 0 && res.body.retryAfterMs <= 200);
    assert.ok(Number(res.headers['Retry-After']) > 0);
    // Rejected before streaming ever started (validation/cooldown path).
    assert.equal(res.written.length, 0);
  });

  await t.test('send succeeds again once the cooldown has elapsed', async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const res = makeRes();
    await handler(makeReq('Third post, mail hr@acme.com to apply.'), res);
    assert.equal(res.statusCode, 200);
    assert.equal(events(res).at(-1).phase, 'sent');
  });

  await t.test('validation errors still return before any cooldown check', async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: { postText: '', recipientEmail: '' } }, res);
    assert.equal(res.statusCode, 400);
  });
});
