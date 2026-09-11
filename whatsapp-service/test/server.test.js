import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../server.js';
import { __test as clientTest } from '../services/whatsappClient.js';

const TEST_KEY = 'test-secret-key-123';
process.env.WHATSAPP_API_KEY = TEST_KEY;

test('healthz endpoint returns ok without api key', async () => {
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  } finally {
    server.close();
  }
});

test('endpoints reject requests without x-api-key', async () => {
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/whatsapp/status`);
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('POST /whatsapp/send rejects invalid phone number', async () => {
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/whatsapp/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': TEST_KEY },
      body: JSON.stringify({ phone: 'invalid-num' })
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /valid phone/i);
  } finally {
    server.close();
  }
});

test('POST /whatsapp/send returns 503 when client is not connected', async () => {
  clientTest.reset();
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/whatsapp/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': TEST_KEY },
      body: JSON.stringify({ phone: '+919876543210' })
    });
    assert.equal(res.status, 503);
    const data = await res.json();
    assert.equal(data.ok, false);
    assert.match(data.error, /not connected/i);
  } finally {
    server.close();
  }
});

test('POST /whatsapp/send succeeds when client is connected', async () => {
  const sentMessages = [];
  const mockClient = {
    onWhatsApp: async (digits) => ([{ jid: `${digits}@s.whatsapp.net`, exists: true }]),
    sendMessage: async (jid, content) => {
      sentMessages.push({ jid, content });
      return { key: { id: 'msg-id-123' } };
    }
  };
  clientTest.setClient(mockClient, 'connected');

  const server = app.listen(0);
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/whatsapp/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': TEST_KEY },
      body: JSON.stringify({ phone: '+919876543210', attachResume: false })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.phone, '+919876543210');
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].jid, '919876543210@s.whatsapp.net');
  } finally {
    server.close();
    clientTest.reset();
  }
});
