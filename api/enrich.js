'use strict';

const telmi = require('../lib/providers/telmiProvider');
const stockbit = require('../lib/providers/stockbitGatewayProvider');
const { setCors } = require('../lib/utils/http');

const MAX_SYMBOLS = 20;
const SYMBOL_PATTERN = /^[A-Z0-9]{1,12}$/;

function send(res, status, body) { return res.status(status).json(body); }

function parseSymbols(value) {
  const raw = Array.isArray(value) ? value.join(',') : String(value || '');
  return Array.from(new Set(raw.split(',').map((item) => item.trim().toUpperCase().replace(/\.JK$/, '')).filter(Boolean)));
}

function direction(value) {
  const normalized = String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (['BUY', 'STRONG_BUY', 'BULLISH', 'POSITIVE', 'ACCUMULATION', 'AKUMULASI'].includes(normalized)) return 'positive';
  if (['SELL', 'STRONG_SELL', 'BEARISH', 'NEGATIVE', 'DISTRIBUTION', 'DISTRIBUSI', 'AVOID'].includes(normalized)) return 'negative';
  if (['HOLD', 'WATCH', 'NEUTRAL', 'SIDEWAYS'].includes(normalized)) return 'neutral';
  return null;
}

function consensusFor(entry) {
  const votes = [];
  const telmiVote = direction(entry?.telmi?.signal);
  if (telmiVote) votes.push({ source:'telmi', direction:telmiVote });
  let stockbitVote = direction(entry?.stockbit?.signal || entry?.stockbit?.sentiment);
  if (!stockbitVote) {
    const net = Number(entry?.stockbit?.brokerSummary?.netBuyValue);
    if (Number.isFinite(net) && net !== 0) stockbitVote = net > 0 ? 'positive' : 'negative';
  }
  if (stockbitVote) votes.push({ source:'stockbit', direction:stockbitVote });
  const positive = votes.filter((vote) => vote.direction === 'positive').length;
  const negative = votes.filter((vote) => vote.direction === 'negative').length;
  const neutral = votes.filter((vote) => vote.direction === 'neutral').length;
  let status = 'unavailable';
  if (positive && negative) status = 'mixed';
  else if (positive >= 2) status = 'confirmed_positive';
  else if (negative >= 2) status = 'confirmed_negative';
  else if (positive || negative) status = 'single_source';
  else if (neutral) status = 'neutral';
  return { status, positive, negative, neutral, votes };
}

function publicSource(result) {
  const { enrichments, ...source } = result;
  return source;
}

module.exports = async function handler(req, res) {
  setCors(res);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return send(res, 405, { ok:false, error:'METHOD_NOT_ALLOWED' });

  const symbols = parseSymbols(req.query?.symbols);
  if (!symbols.length) return send(res, 400, { ok:false, error:'SYMBOLS_REQUIRED' });
  if (symbols.length > MAX_SYMBOLS) return send(res, 400, { ok:false, error:'TOO_MANY_SYMBOLS', maxSymbols:MAX_SYMBOLS });
  const invalidSymbols = symbols.filter((symbol) => !SYMBOL_PATTERN.test(symbol));
  if (invalidSymbols.length) return send(res, 400, { ok:false, error:'INVALID_SYMBOLS', invalidSymbols });

  const [telmiResult, stockbitResult] = await Promise.all([
    telmi.getEnrichment(symbols),
    stockbit.getEnrichment(symbols),
  ]);
  const enrichments = {};
  for (const symbol of symbols) {
    const entry = {
      ...(telmiResult.enrichments[symbol] || {}),
      ...(stockbitResult.enrichments[symbol] || {}),
    };
    if (!Object.keys(entry).length) continue;
    enrichments[symbol] = { ...entry, consensus:consensusFor(entry) };
  }

  return send(res, 200, {
    ok:true,
    generatedAt:new Date().toISOString(),
    requestedSymbols:symbols,
    matchedSymbols:Object.keys(enrichments),
    enrichments,
    sources:{ telmi:publicSource(telmiResult), stockbit:publicSource(stockbitResult) },
    scoringImpact:'none',
    disclaimer:'External enrichment is read-only confirmation data and does not change the core scanner score.',
  });
};
