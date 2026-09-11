import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

let cerebrasCalls = 0;
let whatsappCalls = [];
let emailCalls = [];

mock.module('../services/cerebrasService.js', {
  namedExports: {
    extractConceptAndDraft: async (text) => {
      cerebrasCalls += 1;
      return {
        concept: 'Acme Frontend Role',
        subject: 'Application for Frontend Role – Jashanpreet Singh',
        body: 'Dear Team,\n\nThe post resonated with me.\n\nI have shipped apps.\n\nI am available.\n\nLooking forward to speaking.\n\nSincerely,\n\nJashanpreet Singh'
      };
    }
  }
});

mock.module('../services/whatsappService.js', {
  namedExports: {
    sendWhatsappDirect: async ({ phone, message, attachResume }) => {
      whatsappCalls.push({ phone, message, attachResume });
      return { ok: true, phone, attachmentSent: true, previouslySent: false };
    },
    enqueueWhatsappMessage: async (phone, message) => {
      whatsappCalls.push({ phone, message, attachResume: true });
      return { ok: true, id: 'wa-job-1' };
    },
    getWhatsappJob: async () => ({ status: 'sent' }),
    getWhatsappStatus: async () => ({ connected: true }),
    getWhatsappQr: async () => ({ status: 'connected' })
  }
});

mock.module('../services/emailService.js', {
  namedExports: {
    sendOutreachEmail: async (opts) => {
      emailCalls.push(opts);
      return { ok: true };
    }
  }
});

const { default: handler } = await import('../api/send-outreach.js');

function createMockRes() {
  const chunks = [];
  return {
    headers: {},
    statusCode: 200,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    write(chunk) {
      chunks.push(chunk);
    },
    end() {
      this.ended = true;
    },
    json(body) {
      this.body = body;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(k, v) {
      this.headers[k] = v;
    },
    getEvents() {
      return chunks.flatMap(c => c.split('\n').filter(Boolean).map(JSON.parse));
    }
  };
}

test('channel=whatsapp sends directly without calling LLM draft generator', async () => {
  cerebrasCalls = 0;
  whatsappCalls = [];
  const req = {
    method: 'POST',
    body: {
      postText: 'Hiring software engineers immediately.',
      recipientPhone: '+919876543210',
      channel: 'whatsapp'
    }
  };
  const res = createMockRes();
  await handler(req, res);

  assert.equal(cerebrasCalls, 0, 'Should not invoke LLM drafting for WhatsApp channel');
  assert.equal(whatsappCalls.length, 1);
  assert.equal(whatsappCalls[0].phone, '+919876543210');
  assert.equal(whatsappCalls[0].attachResume, true);

  const events = res.getEvents();
  const sentEvent = events.find(e => e.phase === 'sent');
  assert.ok(sentEvent, 'Should emit sent phase event');
  assert.equal(sentEvent.channel, 'whatsapp');
  assert.equal(sentEvent.attachmentSent, true);
});

test('channel=both drafts email with LLM and sends WhatsApp directly', async () => {
  cerebrasCalls = 0;
  whatsappCalls = [];
  emailCalls = [];
  const req = {
    method: 'POST',
    body: {
      postText: 'Hiring React dev. Contact us at hr@acme.com',
      recipientEmail: 'hr@acme.com',
      recipientPhone: '+919876543210',
      channel: 'both'
    }
  };
  const res = createMockRes();
  await handler(req, res);

  assert.equal(cerebrasCalls, 1, 'Should call LLM once for email draft');
  assert.equal(emailCalls.length, 1);
  assert.equal(whatsappCalls.length, 1);
  assert.equal(whatsappCalls[0].phone, '+919876543210');

  const events = res.getEvents();
  const emailSent = events.find(e => e.phase === 'sent' && e.channel === 'email');
  const waSent = events.find(e => e.phase === 'sent' && e.channel === 'whatsapp');
  assert.ok(emailSent, 'Should emit email sent event');
  assert.ok(waSent, 'Should emit WhatsApp sent event');
});
