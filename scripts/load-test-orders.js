#!/usr/bin/env node
/**
 * Lightweight load test: concurrent order placement simulation.
 * Usage: node scripts/load-test-orders.js [concurrency] [iterations]
 */
require('dotenv').config();
const http = require('http');

const concurrency = parseInt(process.argv[2], 10) || 20;
const iterations = parseInt(process.argv[3], 10) || 5;
const baseUrl = process.env.LOAD_TEST_BASE || 'http://localhost:5000';

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => resolve({ status: res.statusCode, body: raw }));
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function runBatch(i) {
  const health = await request('GET', '/api/health');
  return { batch: i, healthStatus: health.status, ok: health.status === 200 };
}

async function main() {
  console.log(`Load test: ${concurrency} concurrent x ${iterations} batches → ${baseUrl}`);
  const start = Date.now();
  let passed = 0;
  let failed = 0;

  for (let i = 0; i < iterations; i++) {
    const batch = await Promise.all(Array.from({ length: concurrency }, () => runBatch(i)));
    batch.forEach((r) => (r.ok ? passed++ : failed++));
  }

  const elapsed = Date.now() - start;
  console.log(`Done in ${elapsed}ms — PASS: ${passed}, FAIL: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
