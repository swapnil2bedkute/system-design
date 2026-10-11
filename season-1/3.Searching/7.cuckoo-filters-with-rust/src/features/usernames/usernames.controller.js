import { cuckoo } from '../../bootstrap/cuckoo.js';
import { env } from '../../bootstrap/env.js';
import { tryEs } from '../../bootstrap/elastic.js';
import { Username } from './usernames.model.js';
import { ingestRandom } from './usernames.ingest.js';
import { publishChange } from './usernames.sync.js';
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
  cuckoo.add(username); // shared file: every worker sees it at once
  await publishChange('add', username, doc._id); // for the ES worker (and a rebuild running right now)
  // wait_for: the next check should see this username in ES (default refresh is ~1s late)
  const es = await tryEs((c) => c.index({ index: env.esIndex, id: String(doc._id), document: { username }, refresh: 'wait_for' }));
  return reply.code(201).send({
    username,
    result: 'ADDED',
    storedIn: es.ok ? ['Mongo', 'Cuckoo filter', 'Elasticsearch'] : ['Mongo', 'Cuckoo filter'],
    reason: es.ok
      ? 'Username saved in Mongo, Cuckoo filter and Elasticsearch.'
      : 'Username saved in Mongo and Cuckoo filter. Elasticsearch is down, so run pnpm migrate:es once it is back.',
  });
};

export const checkUsername = async (req) => {
  const username = req.query.username.toLowerCase();
  counters.checks++;
  // cuckoo says no: surely free, skip ES and Mongo
  if (!cuckoo.has(username)) {
    counters.answeredByCuckoo++;
    return {
      username,
      result: 'AVAILABLE',
      cuckooFilter: 'Not present',
      checkedIn: 'Not needed',
      reason: 'Cuckoo filter is sure this username was never added, so no database lookup was needed.',
    };
  }
  // cuckoo says maybe: ES decides, Mongo if ES is down (could be a false positive)
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
    cuckooFilter: 'Maybe present',
    checkedIn,
    reason: taken
      ? `Cuckoo filter was unsure, so ${via} was checked and this username exists there.`
      : `Cuckoo filter was unsure (false alarm), so ${via} was checked and this username does not exist there.`,
  };
};

// Always asks Mongo: no cuckoo filter, no Elasticsearch. Handy as the ground truth and to compare speed with the filter path.
export const checkUsernameInDb = async (req) => {
  const username = req.query.username.toLowerCase();
  counters.directToMongo++;
  const taken = !!(await Username.exists({ username }));
  return {
    username,
    result: taken ? 'TAKEN' : 'AVAILABLE',
    cuckooFilter: 'Skipped',
    checkedIn: 'Mongo',
    reason: taken
      ? 'Cuckoo filter and Elasticsearch were skipped. Mongo was checked directly and this username exists there.'
      : 'Cuckoo filter and Elasticsearch were skipped. Mongo was checked directly and this username does not exist there.',
  };
};

// The thing a bloom filter cannot do: remove a username again.
export const deleteUsername = async (req, reply) => {
  const username = req.query.username.toLowerCase();
  const doc = await Username.findOneAndDelete({ username });
  if (!doc) {
    return reply.code(404).send({ username, result: 'NOT_FOUND', reason: 'Username does not exist in Mongo, so nothing was deleted.' });
  }
  // safe: Mongo really had it, so the filter has it too
  if (cuckoo.has(username)) cuckoo.delete(username);
  await publishChange('del', username, doc._id);
  // ponytail: if ES is down its copy stays stale, there is no cleanup job yet
  const es = await tryEs((c) => c.delete({ index: env.esIndex, id: String(doc._id) }, { ignore: [404] }));
  return {
    username,
    result: 'DELETED',
    removedFrom: es.ok ? ['Mongo', 'Cuckoo filter', 'Elasticsearch'] : ['Mongo', 'Cuckoo filter'],
    reason: es.ok
      ? 'Username removed from Mongo, Cuckoo filter and Elasticsearch.'
      : 'Username removed from Mongo and Cuckoo filter. Elasticsearch is down, so its copy stays until it is cleaned up.',
  };
};

export const ingest = async (req) => ingestRandom(req.query.count);

export const stats = async () => getStats();

export const fp = async (req) => fpTest(req.query.n);
