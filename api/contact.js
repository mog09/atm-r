export default async function handler(req, res) {
  // CORS headers so the browser doesn't block the request
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text } = req.body || {};
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ error: 'Missing message text' });
  }

  const token  = process.env.TG_BOT;
  const chatId = process.env.TG_CHAT;

  if (!token || !chatId) {
    console.error('ENV MISSING — TG_BOT:', !!token, 'TG_CHAT:', !!chatId);
    return res.status(500).json({ error: 'Server configuration error — env vars not set' });
  }

  try {
    const tgRes = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: text.substring(0, 4000),
          parse_mode: 'HTML',
        }),
      }
    );

    const data = await tgRes.json();

    if (!tgRes.ok || !data.ok) {
      console.error('Telegram API error:', JSON.stringify(data));
      return res.status(502).json({ error: 'Telegram rejected the message', detail: data.description });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Fetch exception:', e.message);
    return res.status(500).json({ error: 'Internal server error', detail: e.message });
  }
}
