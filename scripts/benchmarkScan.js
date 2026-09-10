'use strict';

const fs = require('node:fs');
const path = require('node:path');

async function run() {
  const route = process.argv[2] || 'scan';
  if (!['scan', 'eveningScan'].includes(route)) throw new Error('Choose scan or eveningScan');
  const handler = require(`../api/${route}`);
  const query = { limit:String(Number(process.argv[3]) || 120), debug:'1' };
  if (route === 'eveningScan') query.mockTime = `${new Date().toLocaleDateString('en-CA', { timeZone:'Asia/Jakarta' })}T17:00:00+07:00`;
  const start = Date.now();
  let status;
  let body;
  await handler({ method:'GET', query }, {
    setHeader() {}, status(value) { status = value; return this; }, json(value) { body = value; },
  });
  const report = { observedAt:new Date().toISOString(), route, query, status, elapsedMs:Date.now() - start,
    summary:body?.summary, diagnostics:body?.diagnostics,
    limitations:'Fresh local process and real provider requests, not a deployed Vercel cold start; evening clock override only opens route; debug disables persistence.' };
  console.log(JSON.stringify(report, null, 2));
  if (process.argv[4]) {
    const output = path.resolve(process.argv[4]);
    fs.mkdirSync(path.dirname(output), { recursive:true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
  }
  if (status !== 200 || !body?.ok) process.exitCode = 1;
}

if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
