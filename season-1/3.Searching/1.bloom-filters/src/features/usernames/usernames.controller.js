import { bloom } from '../../bootstrap/bloom.js';
import { env } from '../../bootstrap/env.js';
import { tryEs } from '../../bootstrap/elastic.js';
import { Username } from './usernames.model.js';
import { ingestRandom } from './usernames.ingest.js';
import { counters, getStats, fpTest } from './usernames.stats.js';

export const addUsername = async (req, reply) => {
  const username = req.body.username.toLowerCase();
  let doc;
  try {
    doc = await Username.create({ username }); // Mongo first, unique index is the guard
  } catch (err) {
    if (err.code === 11000) {
      return reply.code(409).send({ username, result: 'TAKEN', reason: 'Username already exists in Mongo, so nothing was added.' });
    }
    throw err;
  }
  bloom.add(username);
  // wait_for: the next check should see this username in ES (default refresh is ~1s late)
  const es = await tryEs((c) => c.index({ index: env.esIndex, id: String(doc._id), document: { username }, refresh: 'wait_for' }));
  return reply.code(201).send({
    username,
    result: 'ADDED',
    storedIn: es.ok ? ['Mongo', 'Elasticsearch'] : ['Mongo'],
    reason: es.ok
      ? 'Username saved in Mongo and Elasticsearch.'
      : 'Username saved in Mongo. Elasticsearch is down, so run pnpm migrate:es once it is back.',
  });
};

export const checkUsername = async (req) => {
  const username = req.query.username.toLowerCase();
  counters.checks++;
  // bloom says no: surely free, skip ES and Mongo
  if (!bloom.has(username)) {
    counters.answeredByBloom++;
    return {
      username,
      result: 'AVAILABLE',
      bloomFilter: 'Not present',
      checkedIn: 'Not needed',
      reason: 'Bloom filter is sure this username was never added, so no database lookup was needed.',
    };
  }
  // bloom says maybe: ES decides, Mongo if ES is down (could be a false positive)
  // ?consistency=strong forces Mongo (source of truth) even when ES is healthy; eventual (default) uses ES
  const forceMongo = req.query.consistency === 'strong';
  const viaEs = forceMongo ? { ok: false } : await tryEs((c) => c.count({ index: env.esIndex, query: { term: { username } } }));
  let taken, checkedIn, via;
  if (viaEs.ok) {
    counters.wentToEs++;
    taken = viaEs.value.count > 0;
    checkedIn = 'Elasticsearch';
    via = 'Elasticsearch';
  } else {
    counters.wentToMongo++;
    taken = !!(await Username.exists({ username }));
    checkedIn = 'Mongo';
    via = forceMongo ? 'Mongo' : 'Mongo (Elasticsearch is down)';
  }
  return {
    username,
    result: taken ? 'TAKEN' : 'AVAILABLE',
    bloomFilter: 'Maybe present',
    checkedIn,
    reason: taken
      ? `Bloom filter was unsure, so ${via} was checked and this username exists there.`
      : `Bloom filter was unsure (false alarm), so ${via} was checked and this username does not exist there.`,
  };
};

export const ingest = async (req) => ingestRandom(req.query.count);

export const stats = async () => getStats();

export const fp = async (req) => fpTest(req.query.n);
