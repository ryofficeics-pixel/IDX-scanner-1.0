function numberValue(value) {
  if (value === null || value === undefined || value === '' || value === '-') return null;
  if (typeof value === 'object') {
    for (const key of ['raw', 'value', 'amount', 'quantity', 'volume', 'lot']) {
      if (Object.hasOwn(value, key)) {
        const parsed = numberValue(value[key]);
        if (parsed !== null) return parsed;
      }
    }
    return null;
  }
  const cleaned = String(value).trim().replace(/,/g, '').replace(/%$/, '');
  if (!/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function compact(value) {
  if (Array.isArray(value)) return value.map(compact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, compact(item)])
    .filter(([, item]) => item !== null
      && item !== undefined
      && item !== ''
      && !(item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === 0)));
}

function get(object, path) {
  return path.reduce((value, key) => value && typeof value === 'object' ? value[key] : undefined, object);
}

function firstNumber(object, paths) {
  for (const path of paths) {
    const value = numberValue(get(object, path));
    if (value !== null) return value;
  }
  return null;
}

function firstText(object, paths) {
  for (const path of paths) {
    const value = get(object, path);
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 120);
  }
  return null;
}

function brokerRows(rows, side) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 10).map((row) => compact({
    broker:typeof row?.code === 'string' ? row.code.slice(0, 12) : null,
    value:numberValue(row?.netValueIdr),
    lot:numberValue(row?.netLots),
    average:numberValue(row?.avgPrice),
    investorType:typeof row?.investorType === 'string' ? row.investorType.slice(0, 30) : null,
    side,
  })).filter((row) => row.broker);
}

function detectorReading(summary) {
  const detector = summary?.bandarDetector;
  if (!detector || typeof detector !== 'object') return { label:null, amount:null };
  const blocks = ['avg', 'avg5', 'top5', 'top3', 'top1'];
  for (const key of blocks) {
    const block = detector[key];
    const label = typeof block?.accdist === 'string' ? block.accdist.trim() : '';
    const amount = numberValue(block?.amount);
    if (label || amount !== null) return { label:label || null, amount };
  }
  return {
    label:typeof detector.broker_accdist === 'string' ? detector.broker_accdist.trim() : null,
    amount:numberValue(detector.amount),
  };
}

function signalFor(reading, threshold) {
  if (reading.amount !== null) {
    if (reading.amount > threshold) return 'ACCUMULATION';
    if (reading.amount < -threshold) return 'DISTRIBUTION';
    return 'NEUTRAL';
  }
  const label = String(reading.label || '').toLowerCase();
  if (label.includes('acc')) return 'ACCUMULATION';
  if (label.includes('dist')) return 'DISTRIBUTION';
  return null;
}

export function normalizeBrokerSummary(summary, { thresholdIdr = 0, period = 'LATEST' } = {}) {
  if (!summary || typeof summary !== 'object') return {};
  const hasPayload = typeof summary.symbol === 'string'
    || typeof summary.from === 'string'
    || typeof summary.to === 'string'
    || Array.isArray(summary.buyers)
    || Array.isArray(summary.sellers)
    || (summary.bandarDetector && typeof summary.bandarDetector === 'object');
  if (!hasPayload) return {};
  const reading = detectorReading(summary);
  const signal = signalFor(reading, thresholdIdr);
  const dates = [summary.from, summary.to].filter((value, index, values) => typeof value === 'string' && values.indexOf(value) === index);
  const description = [reading.label ? `Stockbit detector: ${reading.label}` : null, period, dates.length ? dates.join(' - ') : null]
    .filter(Boolean).join(' · ');
  return compact({
    signal,
    sentiment:signal === 'ACCUMULATION' ? 'bullish' : signal === 'DISTRIBUTION' ? 'bearish' : signal === 'NEUTRAL' ? 'neutral' : null,
    summary:description || null,
    brokerSummary:{
      netBuyValue:reading.amount,
      topBuyers:brokerRows(summary.buyers, 'buy'),
      topSellers:brokerRows(summary.sellers, 'sell'),
      timestamp:typeof summary.to === 'string' ? summary.to : null,
    },
  });
}

export function normalizeQuote(quote) {
  if (!quote || typeof quote !== 'object') return {};
  return compact({
    quote:{
      price:numberValue(quote.price),
      bid:numberValue(quote.bestBid?.price),
      offer:numberValue(quote.bestOffer?.price),
    },
  });
}

function depthRows(book, side) {
  const rows = book?.[side];
  // Stockbit can expose a different number of levels on each side. Comparing
  // the first five levels of both ladders avoids a plausible-looking skew
  // caused only by one side having more visible rows.
  return Array.isArray(rows) ? rows.slice(0, 5) : [];
}

function depthTotal(rows) {
  let total = 0;
  let found = false;
  for (const row of rows) {
    const value = firstNumber(row, [['volume'], ['quantity'], ['lot'], ['total_volume'], ['totalQuantity']]);
    if (value === null) continue;
    found = true;
    total += Math.abs(value);
  }
  return found ? total : null;
}

export function normalizeOrderbook(book, quote = null) {
  if (!book || typeof book !== 'object') return {};
  const bids = depthRows(book, 'bid');
  const offers = depthRows(book, 'offer');
  const bidDepth = depthTotal(bids);
  const offerDepth = depthTotal(offers);
  const depthSum = bidDepth !== null && offerDepth !== null ? bidDepth + offerDepth : 0;
  const imbalance = depthSum > 0 ? ((bidDepth - offerDepth) / depthSum) * 100 : null;
  const bestBid = firstNumber(book, [
    ['iepiev', 'best_bid_offer', 'bid', 'price'],
    ['best_bid_offer', 'bid', 'price'],
    ['bestBid', 'price'],
    ['bid', 0, 'price'],
  ]) ?? numberValue(quote?.bestBid?.price);
  const bestOffer = firstNumber(book, [
    ['iepiev', 'best_bid_offer', 'offer', 'price'],
    ['best_bid_offer', 'offer', 'price'],
    ['bestOffer', 'price'],
    ['offer', 0, 'price'],
  ]) ?? numberValue(quote?.bestOffer?.price);
  return compact({ orderbook:{ imbalance, bestBid, bestOffer, bidDepth, offerDepth } });
}

function financialItems(payload) {
  const out = new Map();
  const groups = payload?.closure_fin_items_results;
  if (!Array.isArray(groups)) return out;
  for (const group of groups) {
    if (!Array.isArray(group?.fin_name_results)) continue;
    for (const raw of group.fin_name_results) {
      const name = typeof raw?.fitem_name === 'string' ? raw.fitem_name : raw?.fitem?.name;
      const value = raw?.fitem_value ?? raw?.fitem?.value;
      if (typeof name === 'string' && value !== null && value !== undefined) out.set(name.toLowerCase(), value);
    }
  }
  return out;
}

function metric(items, names) {
  for (const name of names) {
    const value = numberValue(items.get(name.toLowerCase()));
    if (value !== null) return value;
  }
  return null;
}

export function normalizeFundamentals(keystats) {
  const items = financialItems(keystats);
  return compact({ fundamentals:{
    pe:metric(items, ['Current PE Ratio (TTM)', 'Current PE Ratio (Annualised)', 'Forward PE Ratio']),
    pbv:metric(items, ['Current Price to Book Value']),
    roe:metric(items, ['Return on Equity (TTM)']),
    der:metric(items, ['Debt to Equity Ratio (Quarter)', 'LT Debt/Equity (Quarter)']),
  } });
}

export function mergeNormalized(...parts) {
  const merged = {};
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    for (const [key, value] of Object.entries(part)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) merged[key] = { ...(merged[key] || {}), ...value };
      else if (value !== null && value !== undefined && value !== '') merged[key] = value;
    }
  }
  return compact(merged);
}

export const internals = { numberValue, detectorReading, signalFor, financialItems, firstText };
