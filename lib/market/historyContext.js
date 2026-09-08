'use strict';

const { sessionContext } = require('./idxSession');

const BAR_MS = 5 * 60 * 1000;
const number = (value, fallback = null) => value == null || value === '' || !Number.isFinite(Number(value)) ? fallback : Number(value);
const dayKey = (value) => new Date(new Date(value).getTime() + 7 * 3600000).toISOString().slice(0, 10);
const minuteOfDay = (value) => { const date = new Date(new Date(value).getTime() + 7 * 3600000); return date.getUTCHours() * 60 + date.getUTCMinutes(); };

function completedDaily(rows = [], now = new Date()) {
  const date = dayKey(now);
  const afterClose = minuteOfDay(now) >= 17 * 60;
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if (!(number(row?.close) > 0)) return false;
    if (!(row.timestamp || row.date)) return true;
    if (!Number.isFinite(new Date(row.timestamp || row.date).getTime())) return false;
    const key = dayKey(row.timestamp || row.date);
    return key < date || (afterClose && key === date);
  })
    .slice().sort((a, b) => String(a.timestamp || a.date || '').localeCompare(String(b.timestamp || b.date || '')));
}

function validBar(row) {
  if (!row || typeof row !== 'object') return false;
  const values = ['open', 'high', 'low', 'close', 'volume'].map((key) => number(row[key]));
  return values.every((value) => value != null) && values.slice(0, 4).every((value) => value > 0)
    && values[4] >= 0 && row.high >= Math.max(row.open, row.close) && row.low <= Math.min(row.open, row.close)
    && Number.isFinite(new Date(row.timestamp).getTime());
}

function partitionIntraday(rows = [], now = new Date()) {
  const cutoff = new Date(now).getTime();
  const current = [];
  const groups = new Map();
  const today = dayKey(now);
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    if (!row.timestamp) { current.push(row); continue; }
    const timestamp = new Date(row.timestamp).getTime();
    // Providers stamp bars at interval start. OHLCV is usable only after the interval closes.
    if (!Number.isFinite(timestamp) || timestamp + BAR_MS > cutoff || !validBar(row)) continue;
    const continuous = (time) => ['MORNING', 'AFTERNOON', 'PRE_CLOSE'].includes(sessionContext(new Date(time)).status);
    if (!continuous(timestamp) || !continuous(timestamp + BAR_MS - 1)) continue;
    const key = dayKey(row.timestamp);
    if (key === today) current.push(row);
    else if (key < today) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
  }
  const sorted = (bars) => bars.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
  return { current:sorted(current), baselines:[...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-10).map(([, bars]) => sorted(bars)) };
}

function verifiedQuote(stock, current) {
  if (stock.timestampSource !== 'fetch' || !current.length) return stock;
  const bars = current.filter(validBar);
  if (!bars.length) return stock;
  const last = bars.at(-1);
  // A fetch-time-only quote is display data. Signals use the last completed market candle instead.
  return { ...stock, lastPrice:last.close, dayOpen:bars[0].open,
    dayHigh:Math.max(...bars.map((row) => row.high)), dayLow:Math.min(...bars.map((row) => row.low)),
    volume:bars.reduce((sum, row) => sum + row.volume, 0),
    timestamp:new Date(new Date(last.timestamp).getTime() + BAR_MS).toISOString(), timestampSource:'completed-candle',
    source:`${stock.source || 'quote'}+5m-candles`, fetchedQuotePrice:stock.lastPrice };
}

module.exports = { BAR_MS, number, dayKey, minuteOfDay, validBar, completedDaily, partitionIntraday, verifiedQuote };
