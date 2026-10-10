// Every function here returns { status, body } and knows nothing about HTTP. The routes in src/http/app.js call them.
import { cuckoo } from '../../bootstrap/cuckoo.js';
import { env } from '../../bootstrap/env.js';
import { tryEs } from '../../bootstrap/elastic.js';
import { Username } from './usernames.model.js';
import { ingestRandom } from './usernames.ingest.js';
import { publishChange } from './usernames.sync.js';
import { counters, getStats, fpTest } from './usernames.stats.js';

export const addUsername = async (username) => {
  let doc;
  try {
    doc = await Username.create({ username }); // Mongo first, unique index is the guard
  } catch (err) {
    if (err.code === 11000) {
      return { status: 409, body: { username, result: 'TAKEN', reason: 'Username already exists in Mongo, so nothing was added.' } };
    }
    throw err;
  }
  // the stream tells every worker (this one too) to add it. Redis down: at least this worker learns it.
  if (!(await publishChange('add', username, doc._id))) cuckoo.add(username);
  // wait_for: the next check should see this username in ES (default refresh is ~1s late)
  const es = await tryEs((c) => c.index({ index: env.esIndex, id: String(doc._id), document: { username }, refresh: 'wait_for' }));
  return {
    status: 201,
    body: {
      username,
      result: 'ADDED',
      storedIn: es.ok ? ['Mongo', 'Cuckoo filter', 'Elasticsearch'] : ['Mongo', 'Cuckoo filter'],
      reason: es.ok
        ? 'Username saved in Mongo, Cuckoo filter and Elasticsearch.'
        : 'Username saved in Mongo and Cuckoo filter. Elasticsearch is down, so run pnpm migrate:es once it is back.',
    },
  };
};

// The answer for a new name is always the same except for the username, so it is one string (no JSON.stringify per request).
// The username already passed validName (only [A-Za-z0-9_]), so it needs no JSON escaping.
const NEW_HEAD = '{"username":"';
const NEW_TAIL =
  '","result":"AVAILABLE","cuckooFilter":"Not present","checkedIn":"Not needed","reason":"Cuckoo filter is sure this username was never added, so no database lookup was needed."}';

// Hot path, fully synchronous. Returns the answer text when the filter is sure the name is free, otherwise null.
export const checkFast = (username) => {
  counters.checks++;
  if (cuckoo.has(username)) return null;
  counters.answeredByCuckoo++;
  return NEW_HEAD + username + NEW_TAIL;
};

// The filter was unsure: ES decides, Mongo if ES is down (could be a false positive).
// forceMongo (consistency=strong) asks Mongo even when ES is healthy.
export const checkSlow = async (username, forceMongo) => {
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
    status: 200,
    body: {
      username,
      result: taken ? 'TAKEN' : 'AVAILABLE',
      cuckooFilter: 'Maybe present',
      checkedIn,
      reason: taken
        ? `Cuckoo filter was unsure, so ${via} was checked and this username exists there.`
        : `Cuckoo filter was unsure (false alarm), so ${via} was checked and this username does not exist there.`,
    },
  };
};

// Always asks Mongo: no cuckoo filter, no Elasticsearch. Handy as the ground truth and to compare speed with the filter path.
export const checkUsernameInDb = async (username) => {
  counters.directToMongo++;
  const taken = !!(await Username.exists({ username }));
  return {
    status: 200,
    body: {
      username,
      result: taken ? 'TAKEN' : 'AVAILABLE',
      cuckooFilter: 'Skipped',
      checkedIn: 'Mongo',
      reason: taken
        ? 'Cuckoo filter and Elasticsearch were skipped. Mongo was checked directly and this username exists there.'
        : 'Cuckoo filter and Elasticsearch were skipped. Mongo was checked directly and this username does not exist there.',
    },
  };
};

// The thing a bloom filter cannot do: remove a username again.
export const deleteUsername = async (username) => {
  const doc = await Username.findOneAndDelete({ username });
  if (!doc) {
    return { status: 404, body: { username, result: 'NOT_FOUND', reason: 'Username does not exist in Mongo, so nothing was deleted.' } };
  }
  // safe: Mongo really had it, so the filter has it too. The stream removes it from every worker.
  if (!(await publishChange('del', username, doc._id)) && cuckoo.has(username)) cuckoo.delete(username);
  // wait_for, same as on add: ES search is ~1s behind, without it the next checks could still find the deleted name and say TAKEN
  // ponytail: if ES is down its copy stays stale, there is no cleanup job yet
  const es = await tryEs((c) => c.delete({ index: env.esIndex, id: String(doc._id), refresh: 'wait_for' }, { ignore: [404] }));
  return {
    status: 200,
    body: {
      username,
      result: 'DELETED',
      removedFrom: es.ok ? ['Mongo', 'Cuckoo filter', 'Elasticsearch'] : ['Mongo', 'Cuckoo filter'],
      reason: es.ok
        ? 'Username removed from Mongo, Cuckoo filter and Elasticsearch.'
        : 'Username removed from Mongo and Cuckoo filter. Elasticsearch is down, so its copy stays until it is cleaned up.',
    },
  };
};

export const ingest = async (count) => ({ status: 200, body: await ingestRandom(count) });

export const stats = () => ({ status: 200, body: getStats() });

export const fp = (n) => ({ status: 200, body: fpTest(n) });
