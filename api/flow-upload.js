'use strict';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function normalizeDate(v) {
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
}
function toDbRow(row) {
  const symbol = String(row.symbol || '').trim().toUpperCase().replace('.JK', '');
  const tradeDate = normalizeDate(row.tradeDate || row.trade_date);
  if (!symbol) throw new Error('symbol required');
  if (!tradeDate) throw new Error('tradeDate required');
  return {
    symbol,
    trade_date: tradeDate,
    broker_buy: num(row.brokerBuy),
    broker_sell: num(row.brokerSell),
    foreign_buy: num(row.foreignBuy),
    foreign_sell: num(row.foreignSell),
    net_buy: num(row.netBuy),
    freq_buy: num(row.freqBuy),
    freq_sell: num(row.freqSell),
    volume_avg5d: num(row.volumeAvg5d),
    source: row.source || 'api-upload',
    updated_at: new Date().toISOString(),
  };
}
async function readBody(req) {
  if (req.body) return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

module.exports = async function handler(req, res) {
  setCors(res);
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ status:'error', error:'METHOD_NOT_ALLOWED' });

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return res.status(503).json({ status:'error', error:'SUPABASE_NOT_CONFIGURED' });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    return res.status(400).json({ status:'error', error:'INVALID_JSON', message:error.message });
  }

  const rows = Array.isArray(body) ? body : body.rows;
  if (!Array.isArray(rows)) return res.status(400).json({ status:'error', error:'ROWS_ARRAY_REQUIRED' });

  const accepted = [];
  const rejected = [];
  rows.forEach((row, index) => {
    try {
      accepted.push(toDbRow(row));
    } catch (error) {
      rejected.push({ index, error:error.message });
    }
  });

  if (!accepted.length) {
    return res.status(400).json({ status:'error', error:'NO_VALID_ROWS', accepted:0, rejected });
  }

  const endpoint = `${url.replace(/\/$/,'')}/rest/v1/idx_flow_data?on_conflict=symbol,trade_date`;
  const upsert = await fetch(endpoint, {
    method:'POST',
    headers:{
      apikey:key,
      Authorization:`Bearer ${key}`,
      'Content-Type':'application/json',
      Prefer:'resolution=merge-duplicates',
    },
    body:JSON.stringify(accepted),
  });

  if (!upsert.ok) {
    const text = await upsert.text();
    return res.status(502).json({ status:'error', error:'SUPABASE_UPSERT_FAILED', message:text, accepted:accepted.length, rejected });
  }

  return res.status(200).json({ status:'ok', accepted:accepted.length, rejected:rejected.length, rejectedRows:rejected });
};

