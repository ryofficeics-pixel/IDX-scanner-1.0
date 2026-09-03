'use strict';

const { sessionContext } = require('../lib/market/idxSession');
const { getScanState } = require('../lib/runtime/scanState');

module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  const state = getScanState();
  const session = sessionContext();
  res.status(200).json({
    ok: true,
    status: 'ok',
    service: 'idx-scanner-1.0',
    version: process.env.VERCEL_GIT_COMMIT_SHA ? process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7) : 'local',
    commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
    serverTime: new Date().toISOString(),
    timezone: 'Asia/Jakarta',
    session: {
      status: session.status,
      sessionProgress: session.sessionProgress,
      expectedVolumeProgress: session.expectedVolumeProgress,
    },
    scanAvailable: true,
    lastSuccessfulScanTimestamp: state.lastSuccessfulScanAt,
    lastScanValidCount: state.lastScanValidCount,
    lastScanFailedCount: state.lastScanFailedCount,
    providers: {
      primary: 'idx-data',
      fallback: 'yahoo-finance/structured-failure',
      statusSummary: state.lastProviderStatus,
    },
    enrichment: {
      mode:'on-demand',
      scoringImpact:'none',
      telmi:{ configured:Boolean(String(process.env.TELMI_API_KEY || '').trim()) },
      stockbit:{ configured:Boolean(String(process.env.STOCKBIT_GATEWAY_URL || '').trim() && String(process.env.STOCKBIT_GATEWAY_TOKEN || '').trim()) },
    },
    cache: {
      status: state.lastCacheStatus,
    },
    supabaseConfigured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
  });
};
