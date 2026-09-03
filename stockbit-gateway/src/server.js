// Set the hard safety posture before stockbit-mcp/core is imported. The gateway
// never imports MCP tools, account actions, or trading modules.
process.env.STOCKBIT_TRADING = 'off';
process.env.STOCKBIT_NO_BROWSER = '1';
process.env.STOCKBIT_TOOLS = 'core';

const [{ createGatewayServer }, { loadConfig }, { createEnrichmentService }, core] = await Promise.all([
  import('./app.js'),
  import('./config.js'),
  import('./enrichment.js'),
  import('stockbit-mcp/core'),
]);

const config = loadConfig();
const enrich = createEnrichmentService({
  getBrokerSummary:core.getBrokerSummary,
  getQuote:core.getQuote,
  getOrderbook:core.getOrderbook,
  getKeystats:core.getKeystats,
}, config);
const server = createGatewayServer({ config, enrich });

server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;

server.listen(config.port, config.host, () => {
  console.log(JSON.stringify({
    event:'stockbit_gateway_started',
    host:config.host,
    port:config.port,
    readOnly:true,
    brokerPeriod:config.brokerPeriod,
    detailSymbolLimit:config.detailSymbolLimit,
  }));
});

function shutdown(signal) {
  console.log(JSON.stringify({ event:'stockbit_gateway_stopping', signal }));
  server.close((error) => {
    process.exitCode = error ? 1 : 0;
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
