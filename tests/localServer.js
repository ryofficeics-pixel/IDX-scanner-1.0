'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const scan = require('../api/scan');
const health = require('../api/health');

function wrap(handler, req, res, query) {
  req.query = Object.fromEntries(query.entries());
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => {
    if (!res.headersSent) res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  };
  Promise.resolve(handler(req, res)).catch((error) => {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok:false, error:error.message }));
  });
}

function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/api/scan') return wrap(scan, req, res, url.searchParams);
    if (url.pathname === '/api/health') return wrap(health, req, res, url.searchParams);

    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const root = path.join(process.cwd(), 'public');
    const target = path.normalize(path.join(root, file));
    if (!target.startsWith(root)) {
      res.statusCode = 403;
      return res.end('Forbidden');
    }
    fs.readFile(target, (error, data) => {
      if (error) {
        res.statusCode = 404;
        return res.end('Not found');
      }
      res.setHeader('Content-Type', target.endsWith('.html') ? 'text/html' : target.endsWith('.js') ? 'application/javascript' : 'application/octet-stream');
      res.end(data);
    });
  });
}

async function startServer(port = 0) {
  const server = createServer();
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  return {
    server,
    url:`http://127.0.0.1:${address.port}`,
    close:() => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { createServer, startServer };
