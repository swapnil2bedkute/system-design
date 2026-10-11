import { mightContain, noteAdded } from '../../bootstrap/fuse.js';
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
  // The stream tells every worker (this one too) to put it in the small "new names" set.
  // Redis down: at least this worker learns it.
  if (!(await publishChange('add', username, doc._id))) noteAdded(username);
  // wait_for: the next check should see this username in ES (default refresh is ~1s late)
  const es = await tryEs((c) => c.index({ index: env.esIndex, id: String(doc._id), document: { username }, refresh: 'wait_for' }));
  return reply.code(201).send({
    username,
    result: 'ADDED',
    storedIn: es.ok ? ['Mongo', 'Fuse filter (new names)', 'Elasticsearch'] : ['Mongo', 'Fuse filter (new names)'],
    reason: es.ok
      ? 'Username saved in Mongo, the Fuse filter new-names set and Elasticsearch. The next rebuild folds it into the main filter.'
      : 'Username saved in Mongo and the Fuse filter new-names set. Elasticsearch is down, so run pnpm migrate:es once it is back.',
  });
};

// The answer for a new name is always the same except for the username, so it is one string (no JSON.stringify per request).
// The username already matched [A-Za-z0-9_] in the route schema, so it needs no JSON escaping.
const NEW_HEAD = '{"username":"';
const NEW_TAIL =
  '","result":"AVAILABLE","fuseFilter":"Not present","checkedIn":"Not needed","reason":"Fuse filter is sure this username was never added, so no database lookup was needed."}';

export const checkUsername = async (req, reply) => {
  const username = req.query.username.toLowerCase();
  counters.checks++;
  // filter says no: surely free, skip ES and Mongo
  if (!mightContain(username)) {
    counters.answeredByFuse++;
    return reply.type('application/json; charset=utf-8').send(NEW_HEAD + username + NEW_TAIL);
  }
  // filter says maybe: ES decides, Mongo if ES is down (could be a false positive, or a name deleted since the last rebuild)
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
    fuseFilter: 'Maybe present',
    checkedIn,
    reason: taken
      ? `Fuse filter was unsure, so ${via} was checked and this username exists there.`
      : `Fuse filter was unsure (false alarm, or the name was deleted), so ${via} was checked and this username does not exist there.`,
  };
};

// Always asks Mongo: no fuse filter, no Elasticsearch. Handy as the ground truth and to compare speed with the filter path.
export const checkUsernameInDb = async (req) => {
  const username = req.query.username.toLowerCase();
  counters.directToMongo++;
  const taken = !!(await Username.exists({ username }));
  return {
    username,
    result: taken ? 'TAKEN' : 'AVAILABLE',
    fuseFilter: 'Skipped',
    checkedIn: 'Mongo',
    reason: taken
      ? 'Fuse filter and Elasticsearch were skipped. Mongo was checked directly and this username exists there.'
      : 'Fuse filter and Elasticsearch were skipped. Mongo was checked directly and this username does not exist there.',
  };
};

// A fuse filter cannot remove a name. Mongo and ES forget it at once, the filter forgets it at the next rebuild,
// and until then a check says "maybe", asks the DB and still gets the right answer.
export const deleteUsername = async (req, reply) => {
  const username = req.query.username.toLowerCase();
  const doc = await Username.findOneAndDelete({ username });
  if (!doc) {
    return reply.code(404).send({ username, result: 'NOT_FOUND', reason: 'Username does not exist in Mongo, so nothing was deleted.' });
  }
  await publishChange('del', username, doc._id); // the ES worker uses this line to retry the ES delete
  // ponytail: if ES is down its copy stays stale until the stream retries, the stream does the retry
  // wait_for, same as on add: ES search is ~1s behind, without it the next checks could still find the deleted name and say TAKEN
  const es = await tryEs((c) => c.delete({ index: env.esIndex, id: String(doc._id), refresh: 'wait_for' }, { ignore: [404] }));
  return {
    username,
    result: 'DELETED',
    removedFrom: es.ok ? ['Mongo', 'Elasticsearch'] : ['Mongo'],
    reason: es.ok
      ? 'Username removed from Mongo and Elasticsearch. The Fuse filter keeps the name until its next rebuild, so checks for it still ask the DB.'
      : 'Username removed from Mongo. Elasticsearch is down, so its copy is removed when it is back. The Fuse filter keeps the name until its next rebuild.',
  };
};

export const ingest = async (req) => ingestRandom(req.query.count);

export const stats = async () => getStats();

export const fp = async (req) => fpTest(req.query.n);
