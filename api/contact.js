// Simple in-memory rate limiter (resets per cold start, good enough for Vercel serverless)
const rateMap = new Map();
const RATE_LIMIT = 5;       // max submissions
const RATE_WINDOW = 60000;  // per 60 seconds

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > RATE_WINDOW) {
    rateMap.set(ip, { count: 1, start: now });
    return false;
  }
  entry.count++;
  rateMap.set(ip, entry);
  return entry.count > RATE_LIMIT;
}

// Strip HTML tags to prevent injection into Telegram HTML parse_mode
function stripHtml(str) {
  return str.replace(/<[^>]*>/g, '').replace(/&/g, '&amp;');
}

export default async function handler(req, res) {
  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Restrict CORS to the production domain only
  const origin = req.headers.origin || '';
  const allowed = ['https://www.atm-r.com', 'https://atm-r.com', 'https://atm-r-1-2.vercel.app'];
  if (allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limiting by IP
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many requests — please wait a moment and try again.' });
  }

  // Validate content-type
  const ct = req.headers['content-type'] || '';
  if (!ct.includes('application/json')) {
    return res.status(415).json({ error: 'Unsupported content type' });
  }

  const { text } = req.body || {};
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ error: 'Missing message text' });
  }
  if (text.length > 4000) {
    return res.status(400).json({ error: 'Message too long' });
  }

  const token  = process.env.TG_BOT;
  const chatId = process.env.TG_CHAT;

  if (!token || !chatId) {
    console.error('ENV MISSING — TG_BOT:', !!token, 'TG_CHAT:', !!chatId);
    return res.status(500).json({ error: 'Server configuration error' });
  }

  try {
    const safeText = stripHtml(text).substring(0, 4000);
    const tgRes = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: safeText,
          parse_mode: 'HTML',
        }),
      }
    );

    const data = await tgRes.json();

    if (!tgRes.ok || !data.ok) {
      console.error('Telegram API error:', JSON.stringify(data));
      return res.status(502).json({ error: 'Submission failed' });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Fetch exception:', e.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
