'use strict';

/**
 * api/alert.js — Push alert endpoint for STRONG_BUY signals.
 *
 * Sends a notification via ntfy.sh (or a self-hosted ntfy instance) when
 * the frontend detects a STRONG_BUY signal. The frontend POSTs a small
 * payload; this handler forwards it to ntfy with a formatted message.
 *
 * Environment variables:
 *   NTFY_URL    — ntfy server base URL, e.g. https://ntfy.sh or https://ntfy.yourdomain.com
 *                 Defaults to https://ntfy.sh if not set.
 *   NTFY_TOPIC  — ntfy topic name (treat as a secret — anyone with the topic can receive alerts).
 *                 Required. If not set, the endpoint returns 503.
 *   NTFY_TOKEN  — optional Bearer token for private ntfy instances / ntfy.sh pro.
 *
 * POST /api/alert
 * Body: { symbol, action, score, confidence, price, changePct, reasons }
 */

const { setCors } = require('../lib/utils/http');

// Read config at call time (not module load) so tests can set env vars without cache-busting.
function getConfig() {
  return {
    ntfyUrl:   (process.env.NTFY_URL   || 'https://ntfy.sh').replace(/\/$/, ''),
    ntfyTopic: (process.env.NTFY_TOPIC || '').trim(),
    ntfyToken: (process.env.NTFY_TOKEN || ''),
  };
}

function num(v, dec = 2) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(dec) : '-';
}

function buildNtfyPayload(body) {
  const symbol     = String(body.symbol     || '?').toUpperCase();
  const action     = String(body.action     || 'BUY').toUpperCase();
  const score      = num(body.score,      0);
  const confidence = num(body.confidence, 0);
  const price      = num(body.price,      0);
  const changePct  = num(body.changePct,  2);
  const reasons    = Array.isArray(body.reasons)
    ? body.reasons.slice(0, 3).join(' • ')
    : String(body.reasons || '');

  const title   = `${action} ${symbol} +${changePct}%`;
  const message = `Score ${score} | Confidence ${confidence}% | Price ${price}\n${reasons}`;
  const tags    = action === 'STRONG_BUY' ? ['chart_with_upwards_trend', 'rotating_light'] : ['chart_with_upwards_trend'];
  const priority = action === 'STRONG_BUY' ? 4 : 3; // urgent vs high

  return { title, message, tags, priority };
}

module.exports = async function handler(req, res) {
  setCors(res, 'POST, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'METHOD_NOT_ALLOWED' });

  const { ntfyUrl, ntfyTopic, ntfyToken } = getConfig();

  if (!ntfyTopic) {
    return res.status(503).json({ ok:false, error:'NTFY_NOT_CONFIGURED', message:'Set NTFY_TOPIC env var to enable push alerts.' });
  }

  // Parse body
  let body;
  try {
    if (req.body) {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } else {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    }
  } catch (err) {
    return res.status(400).json({ ok:false, error:'INVALID_JSON', message:err.message });
  }

  if (!body.symbol || !body.action) {
    return res.status(400).json({ ok:false, error:'MISSING_FIELDS', message:'symbol and action are required' });
  }

  const { title, message, tags, priority } = buildNtfyPayload(body);
  const ntfyEndpoint = `${ntfyUrl}/${encodeURIComponent(ntfyTopic)}`;

  const headers = {
    'Content-Type': 'text/plain',
    'Title':        title,
    'Tags':         tags.join(','),
    'Priority':     String(priority),
  };
  if (ntfyToken) headers['Authorization'] = `Bearer ${ntfyToken}`;

  try {
    const ntfyRes = await fetch(ntfyEndpoint, {
      method:  'POST',
      headers,
      body:    message,
      signal:  AbortSignal.timeout(6000),
    });
    if (!ntfyRes.ok) {
      const text = await ntfyRes.text().catch(() => '');
      return res.status(502).json({ ok:false, error:'NTFY_ERROR', status:ntfyRes.status, message:text });
    }
    return res.status(200).json({ ok:true, sent:true, topic:ntfyTopic, title });
  } catch (err) {
    return res.status(502).json({ ok:false, error:'NTFY_FETCH_FAILED', message:err.message });
  }
};
