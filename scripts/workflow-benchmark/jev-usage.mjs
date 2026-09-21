// Benchmark-only preload: observe actual HTTP usage without changing production calls.
// Never log request bodies, headers, keys, or response answers.
import { appendFileSync } from 'node:fs';
const original = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const url = new URL(typeof args[0] === 'string' || args[0] instanceof URL ? args[0] : args[0].url);
  if (url.hostname !== 'api.typesafe.ai') return original(...args);
  const start = performance.now();
  try {
    const response = await original(...args);
    let body;
    try { body = await response.clone().json(); } catch {}
    appendFileSync(process.env.BENCH_JEV_USAGE, JSON.stringify({ status: response.status, elapsedMs: performance.now() - start, usage: body?.usage ?? null, model: body?.model ?? null }) + '\n');
    return response;
  } catch (error) {
    appendFileSync(process.env.BENCH_JEV_USAGE, JSON.stringify({ status: null, elapsedMs: performance.now() - start, usage: null, error: error.name }) + '\n');
    throw error;
  }
};
