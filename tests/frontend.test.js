'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadFrontend() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((match) => match[1]).filter(Boolean);
  const fullScript = scripts.at(-1);
  const initMarker = fullScript.lastIndexOf('// INIT\n');
  const appScript = initMarker >= 0 ? fullScript.slice(0, initMarker) : fullScript;
  const context = {
    window:{},
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URLSearchParams,
    AbortSignal,
    fetch:async () => { throw new Error('unexpected fetch'); },
  };
  vm.createContext(context);
  new vm.Script(appScript, { filename:'public/index.html' }).runInContext(context);
  return context;
}

test('frontend defaults to one sync when opened without repeat polling', () => {
  const app = loadFrontend();
  assert.equal(app.STATE.syncInterval, 0);
});

test('external candidate selection prioritizes recommendations and is capped', () => {
  const app = loadFrontend();
  app.STATE.watchlist = ['TLKM', 'BBCA'];
  const symbols = app.symbolsForExternalEnrichment({ recommendations:{
    strongBuy:[{ symbol:'BMRI' }],
    topBuy:[{ symbol:'BBRI' }, { symbol:'BMRI' }],
    topGainers:Array.from({ length:30 }, (_, index) => ({ symbol:`A${index}` })),
  } });
  assert.deepEqual(Array.from(symbols.slice(0,4)), ['BMRI','BBRI','TLKM','BBCA']);
  assert.equal(symbols.length, 20);
});

test('external detail is escaped and explicitly separated from core scoring', () => {
  const app = loadFrontend();
  app.STATE.externalSources = {
    telmi:{ status:'ok', configured:true, matched:1 },
    stockbit:{ status:'disabled', configured:false, matched:0 },
  };
  app.STATE.externalEnrichment = {
    BBCA:{
      telmi:{ signal:'BUY', indicator:'<img src=x onerror=alert(1)>', areaBuyMin:9500, areaBuyMax:9650, tp1:9900, sl:9300 },
      consensus:{ status:'single_source', positive:1, negative:0, neutral:0 },
    },
  };
  const rendered = app.externalDetailHTML({ symbol:'BBCA' });
  assert.match(rendered, /KONFIRMASI EKSTERNAL/);
  assert.match(rendered, /tidak mengubah score inti/);
  assert.match(rendered, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(rendered, /<img src=x/);
  assert.match(rendered, /Stockbit Gateway/);
});
