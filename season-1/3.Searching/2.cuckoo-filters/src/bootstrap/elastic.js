import { Client } from '@elastic/elasticsearch';
import { env } from './env.js';

// short timeout, no retry: if ES is down we want to fall back to Mongo fast
export const es = new Client({ node: env.esUrl, requestTimeout: 1000, maxRetries: 0 });

const COOLDOWN_MS = 10000;
let downUntil = 0;

// Runs fn(es). Returns { ok: true, value } or { ok: false }.
// One failure opens the breaker, so the next 10s skip ES and go straight to Mongo.
// ponytail: in-memory breaker, no half-open probe. Add one if flapping ES matters.
export const tryEs = async (fn) => {
  if (Date.now() < downUntil) return { ok: false };
  try {
    return { ok: true, value: await fn(es) };
  } catch (err) {
    downUntil = Date.now() + COOLDOWN_MS;
    console.warn(`ES unavailable, using Mongo for ${COOLDOWN_MS / 1000}s: ${err.message}`);
    return { ok: false };
  }
};

// Create the index with an exact-match mapping, otherwise ES guesses "text" and term queries misbehave.
export const ensureEsIndex = () =>
  tryEs(async (c) => {
    if (await c.indices.exists({ index: env.esIndex })) return;
    await c.indices.create({
      index: env.esIndex,
      settings: { number_of_shards: 1, number_of_replicas: 0 },
      mappings: { properties: { username: { type: 'keyword' } } },
    });
    console.log(`ES index created: ${env.esIndex}`);
  });
