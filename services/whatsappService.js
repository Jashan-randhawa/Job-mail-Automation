const DEFAULT_TIMEOUT_MS = Number(process.env.WHATSAPP_API_TIMEOUT_MS || 35_000);

function getConfig() {
  const baseUrl = (process.env.WHATSAPP_SERVICE_URL || '').trim().replace(/\/+$/, '');
  const apiKey = (process.env.WHATSAPP_API_KEY || '').trim();
  if (!baseUrl) throw new Error('WHATSAPP_SERVICE_URL is not configured.');
  if (!apiKey) throw new Error('WHATSAPP_API_KEY is not configured.');
  return { baseUrl, apiKey };
}

async function request(path, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const { baseUrl, apiKey } = getConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        ...(options.headers || {}),
        'x-api-key': apiKey,
        'Content-Type': 'application/json'
      }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `WhatsApp service returned HTTP ${response.status}.`);
      error.status = response.status;
      error.code = data.code || (response.status === 401 ? 'UNAUTHORIZED' : undefined);
      throw error;
    }
    return data;
  } catch (err) {
    if (err?.name === 'AbortError') {
      const timeout = new Error(`WhatsApp service timed out after ${timeoutMs}ms.`);
      timeout.code = 'WHATSAPP_SERVICE_TIMEOUT';
      throw timeout;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function getWhatsappStatus() {
  const { baseUrl, apiKey } = getConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${baseUrl}/whatsapp/status`, {
      signal: controller.signal,
      headers: { 'x-api-key': apiKey }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `WhatsApp service returned HTTP ${response.status}.`);
    return data;
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('WhatsApp status request timed out.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function getWhatsappQr() {
  return request('/whatsapp/qr', {}, 10_000);
}

export async function sendWhatsappDirect({ phone, message, attachResume = true, resumePath } = {}) {
  return request('/whatsapp/send', {
    method: 'POST',
    body: JSON.stringify({ phone, message, attachResume, resumePath })
  });
}

// Backward-compatible alias for existing calls
export async function enqueueWhatsappMessage(phone, message) {
  return sendWhatsappDirect({ phone, message });
}

export async function getWhatsappHistory() {
  return request('/whatsapp/history', {}, 10_000);
}

export async function getWhatsappJob(jobId) {
  return request(`/whatsapp/jobs/${encodeURIComponent(jobId)}`).catch(() => ({ status: 'unknown' }));
}

export const __whatsappTest = { getConfig };
