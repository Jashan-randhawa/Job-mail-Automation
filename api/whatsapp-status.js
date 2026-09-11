import 'dotenv/config';
import { getWhatsappJob } from '../services/whatsappService.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.' });
  const jobId = req.query?.jobId;
  if (!jobId) return res.status(400).json({ error: 'jobId is required.' });
  try {
    res.json(await getWhatsappJob(jobId));
  } catch (err) {
    res.status(503).json({ error: err?.message || String(err) });
  }
}
