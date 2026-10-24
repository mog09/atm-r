// api/contact.js: Vercel serverless function for atm-r.com
// Replaces the Telegram forwarder. Sends every form submission to the
// ATM-R Intake webhook, stores an optional candidate CV in Vercel Blob,
// and drops spam.
//
// Vercel environment variables (Project > Settings > Environment Variables):
//   INTAKE_WEBHOOK_URL     webhook URL from the ATM-R Intake routine panel
//   INTAKE_WEBHOOK_KEY     sender key from the same panel
//   BLOB_READ_WRITE_TOKEN  added automatically when a Vercel Blob store is connected
// Remove the old Telegram variables (bot token, chat ID).
//
// Dependency: npm install @vercel/blob

const { put } = require('@vercel/blob');
const crypto = require('crypto');

const MAX_TEXT = 4000;
const MAX_CV_BYTES = 3 * 1024 * 1024; // 3 MB (Vercel request body limit is 4.5 MB)
const MIN_FILL_MS = 3000;             // humans take longer than 3 seconds
const CV_TYPES = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx'
};

function formType(text) {
  const first = (text.split('\n')[0] || '').toUpperCase();
  if (first.includes('CANDIDATE REGISTRATION')) return 'candidate';
  if (first.includes('EMPLOYER REGISTRATION')) return 'employer';
  if (first.includes('CONTACT ENQUIRY')) return 'contact';
  return 'unknown';
}

// Pretend success to bots so they don't retry.
const fakeOk = (res) => res.status(200).json({ ok: true });

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  // Spam trap 1: hidden field that people never see or fill in.
  if (body.website) return fakeOk(res);
  // Spam trap 2: form submitted too fast after the page loaded.
  const started = Number(body.started_at || 0);
  if (!started || Date.now() - started < MIN_FILL_MS) return fakeOk(res);

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const type = text && text.length <= MAX_TEXT ? formType(text) : 'unknown';
  if (type === 'unknown') return res.status(400).json({ ok: false, error: 'Invalid submission' });

  const url = process.env.INTAKE_WEBHOOK_URL;
  const key = process.env.INTAKE_WEBHOOK_KEY;
  if (!url || !key) {
    console.error('Intake webhook is not configured');
    return res.status(500).json({ ok: false, error: 'Submission error' });
  }

  // Optional CV (candidate form only).
  let cv = null;
  if (type === 'candidate' && body.cv && body.cv.data) {
    const ext = CV_TYPES[body.cv.type];
    const buf = Buffer.from(String(body.cv.data), 'base64');
    if (!ext || buf.length === 0 || buf.length > MAX_CV_BYTES) {
      return res.status(400).json({ ok: false, error: 'CV must be a PDF or Word file under 3 MB' });
    }
    try {
      const name = `cvs/${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID()}.${ext}`;
      const blob = await put(name, buf, { access: 'private', contentType: body.cv.type, addRandomSuffix: true });
      cv = { url: blob.url, filename: String(body.cv.name || '').slice(0, 200), type: body.cv.type, bytes: buf.length };
    } catch (e) {
      console.error('CV upload failed', e);
      cv = { error: 'upload_failed', filename: String(body.cv.name || '').slice(0, 200) };
    }
  }

  const payload = {
    source: 'atm-r.com',
    form_type: type,                 // candidate | employer | contact
    submitted_at: new Date().toISOString(),
    text,                            // same multi-line format as the old Telegram alert
    cv                               // null, { url, filename, type, bytes }, or { error, filename }
  };

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Match the header name and format shown with the sender key in the routine panel.
        'Authorization': 'Bearer ' + key
      },
      body: JSON.stringify(payload)
    });
    if (!r.ok) {
      console.error('Intake webhook returned', r.status);
      return res.status(502).json({ ok: false, error: 'Submission error' });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Intake webhook failed', e);
    return res.status(502).json({ ok: false, error: 'Submission error' });
  }
};

// Only used if this runs under Next.js; plain Vercel functions already allow 4.5 MB.
module.exports.config = { api: { bodyParser: { sizeLimit: '4.5mb' } } };
