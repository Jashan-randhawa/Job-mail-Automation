import 'dotenv/config';
import { getWhatsappStatus } from '../../services/whatsappService.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.' });
  try {
    const status = await getWhatsappStatus();
    res.json(status);
  } catch (err) {
    res.status(503).json({ connected: false, status: 'unavailable', error: err?.message || String(err) });
  }
}
