import 'dotenv/config';
import { getWhatsappQr } from '../../services/whatsappService.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.' });
  try {
    res.json(await getWhatsappQr());
  } catch (err) {
    res.status(503).json({ error: err?.message || String(err) });
  }
}
