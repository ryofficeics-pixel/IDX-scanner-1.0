'use strict';

module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json({
    ok: true,
    status: 'ok',
    service: 'idx-scanner-1.0',
    serverTime: new Date().toISOString(),
    timezone: 'Asia/Jakarta',
    scanAvailable: true,
    providers: {
      primary: 'yahoo-finance',
      fallback: 'structured-failure',
    },
    supabaseConfigured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
  });
};
