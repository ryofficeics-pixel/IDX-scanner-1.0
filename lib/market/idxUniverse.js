'use strict';

let rows = [];
try {
  rows = require('../../data/idx-symbols.json');
} catch (_) {
  rows = [];
}

const DEFAULT_IDX_UNIVERSE = (rows.length ? rows : [
  { symbol:'BBCA', name:'PT Bank Central Asia Tbk' },
  { symbol:'BBRI', name:'PT Bank Rakyat Indonesia (Persero) Tbk' },
  { symbol:'BMRI', name:'PT Bank Mandiri (Persero) Tbk' },
  { symbol:'TLKM', name:'PT Telkom Indonesia (Persero) Tbk' },
  { symbol:'ASII', name:'PT Astra International Tbk' },
  { symbol:'BBNI', name:'PT Bank Negara Indonesia (Persero) Tbk' },
  { symbol:'ADRO', name:'PT Alamtri Resources Indonesia Tbk' },
  { symbol:'AMMN', name:'PT Amman Mineral Internasional Tbk' },
  { symbol:'ANTM', name:'PT Aneka Tambang Tbk' },
  { symbol:'BRPT', name:'PT Barito Pacific Tbk' },
  { symbol:'GOTO', name:'PT GoTo Gojek Tokopedia Tbk' },
  { symbol:'ICBP', name:'PT Indofood CBP Sukses Makmur Tbk' },
  { symbol:'INDF', name:'PT Indofood Sukses Makmur Tbk' },
  { symbol:'KLBF', name:'PT Kalbe Farma Tbk' },
  { symbol:'MDKA', name:'PT Merdeka Copper Gold Tbk' },
  { symbol:'UNTR', name:'PT United Tractors Tbk' },
  { symbol:'UNVR', name:'PT Unilever Indonesia Tbk' },
]).filter((row) => row && row.symbol);

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase().replace('.JK', '').replace(/[^A-Z0-9]/g, '');
}

function getUniverse({ symbols, limit } = {}) {
  const bySymbol = new Map(DEFAULT_IDX_UNIVERSE.map((row) => [normalizeSymbol(row.symbol), row]));
  const requested = String(symbols || '').split(',').map(normalizeSymbol).filter(Boolean);
  const source = requested.length ? requested.map((symbol) => bySymbol.get(symbol) || { symbol, name:symbol }) : DEFAULT_IDX_UNIVERSE;
  return source.slice(0, Math.max(1, Math.min(Number(limit) || 120, 180)));
}

module.exports = { DEFAULT_IDX_UNIVERSE, getUniverse, normalizeSymbol };
