import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { tokenMatches } from './auth.js';

const MAX_SYMBOLS = 20;
const MAX_BODY_BYTES = 16 * 1024;
const SYMBOL_PATTERN = /^[A-Z0-9]{1,12}$/;

function sendJson(res, status, body, requestId) {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Request-Id', requestId);
  res.end(payload);
}

async function readJson(req) {
  const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    const error = new Error('CONTENT_TYPE_REQUIRED');
    error.status = 415;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('BODY_TOO_LARGE');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    const error = new Error('INVALID_JSON');
    error.status = 400;
    throw error;
  }
}

function symbolsFrom(body) {
  if (!Array.isArray(body?.symbols)) return { error:'SYMBOLS_REQUIRED' };
  const symbols = Array.from(new Set(body.symbols.map((value) => String(value).trim().toUpperCase().replace(/\.JK$/, '')).filter(Boolean)));
  if (!symbols.length) return { error:'SYMBOLS_REQUIRED' };
  if (symbols.length > MAX_SYMBOLS) return { error:'TOO_MANY_SYMBOLS', maxSymbols:MAX_SYMBOLS };
  const invalidSymbols = symbols.filter((symbol) => !SYMBOL_PATTERN.test(symbol));
  if (invalidSymbols.length) return { error:'INVALID_SYMBOLS', invalidSymbols };
  return { symbols };
}

function createRateLimiter(limit, now = () => Date.now()) {
  let windowStartedAt = now();
  let used = 0;
  return () => {
    const current = now();
    if (current - windowStartedAt >= 60_000) {
      windowStartedAt = current;
      used = 0;
    }
    used += 1;
    return used <= limit;
  };
}

function serialize(run) {
  let tail = Promise.resolve();
  return (...args) => {
    const current = tail.then(() => run(...args), () => run(...args));
    tail = current.catch(() => undefined);
    return current;
  };
}

export function createGatewayServer({ config, enrich, logger = console }) {
  const allowRequest = createRateLimiter(config.rateLimitPerMinute);
  const serializedEnrich = serialize(enrich);
  return createServer(async (req, res) => {
    const requestId = randomUUID();
    const url = new URL(req.url || '/', 'http://gateway.local');

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, {
        ok:true,
        status:'ok',
        service:'idx-stockbit-gateway',
        version:'1.0.0',
        readOnly:true,
        stockbitSessionCheck:'not_run',
        serverTime:new Date().toISOString(),
      }, requestId);
    }

    if (url.pathname !== '/v1/enrich') return sendJson(res, 404, { ok:false, error:'NOT_FOUND' }, requestId);
    if (req.method !== 'POST') return sendJson(res, 405, { ok:false, error:'METHOD_NOT_ALLOWED' }, requestId);
    if (!tokenMatches(req.headers.authorization, config.token)) return sendJson(res, 401, { ok:false, error:'UNAUTHORIZED' }, requestId);
    if (!allowRequest()) {
      res.setHeader('Retry-After', '60');
      return sendJson(res, 429, { ok:false, error:'RATE_LIMITED' }, requestId);
    }

    try {
      const body = await readJson(req);
      const parsed = symbolsFrom(body);
      if (parsed.error) return sendJson(res, 400, { ok:false, ...parsed }, requestId);

      const result = await serializedEnrich(parsed.symbols);
      if (!Object.keys(result.enrichments).length && result.errors.length) {
        logger.warn?.({ event:'stockbit_gateway_upstream_unavailable', requestId, errors:result.errors });
        return sendJson(res, 502, { ok:false, error:'STOCKBIT_UPSTREAM_UNAVAILABLE', errors:result.errors }, requestId);
      }
      return sendJson(res, 200, {
        ok:true,
        generatedAt:new Date().toISOString(),
        requestedSymbols:parsed.symbols,
        matchedSymbols:Object.keys(result.enrichments),
        enrichments:result.enrichments,
        errors:result.errors,
        meta:{
          source:'stockbit-mcp/core',
          sourceVersion:'1.3.0',
          readOnly:true,
          brokerPeriod:config.brokerPeriod,
          detailedSymbols:result.detailedSymbols,
        },
      }, requestId);
    } catch (error) {
      const status = Number(error?.status) || 500;
      const publicCode = status === 415 ? 'CONTENT_TYPE_REQUIRED'
        : status === 413 ? 'BODY_TOO_LARGE'
        : status === 400 ? 'INVALID_JSON'
        : 'INTERNAL_ERROR';
      if (status >= 500) logger.error?.({ event:'stockbit_gateway_request_failed', requestId, error:publicCode });
      return sendJson(res, status, { ok:false, error:publicCode }, requestId);
    }
  });
}

export const internals = { readJson, symbolsFrom, createRateLimiter, serialize, MAX_SYMBOLS, MAX_BODY_BYTES };
