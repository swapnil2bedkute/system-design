import { randomBytes } from 'node:crypto';
import { rebuildXor } from '../../bootstrap/xor.js';
import { publishChange } from './usernames.sync.js';
import { env } from '../../bootstrap/env.js';
import { tryEs } from '../../bootstrap/elastic.js';
import { Username } from './usernames.model.js';

const BATCH = 5000;

const randomName = () => `u_${randomBytes(6).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;

const toEs = (docs) =>
  tryEs(async (c) => {
    const res = await c.bulk(
      { operations: docs.flatMap((d) => [{ index: { _index: env.esIndex, _id: String(d._id) } }, { username: d.username }]) },
      { requestTimeout: 30000 }, // a big bulk needs more than the 1s default
    );
    if (res.errors) throw new Error('ES bulk had item errors');
  });

export const ingestRandom = async (count) => {
  let inserted = 0;
  let esStored = true;
  for (let done = 0; done < count; done += BATCH) {
    const names = Array.from({ length: Math.min(BATCH, count - done) }, randomName);
    let saved = [];
    try {
      saved = await Username.insertMany(names.map((username) => ({ username })), { ordered: false });
    } catch (err) {
      // ponytail: random collisions are skipped, not retried, so inserted can be a bit under count
      if (err.code !== 11000 && !err.writeErrors) throw err;
      saved = err.insertedDocs ?? [];
    }
    inserted += saved.length;
    if (saved.length && !(await toEs(saved)).ok) esStored = false; // Mongo is safe, ES catches up via pnpm migrate:es
  }
  // One line for the whole ingest instead of one per name: every worker re-reads Mongo and rebuilds its filter.
  // Until that finishes (seconds) the new names are not in the filter yet.
  if (inserted && !(await publishChange('rebuild'))) await rebuildXor(); // Redis down: rebuild at least this worker
  return {
    result: 'DONE',
    requested: count,
    inserted,
    storedIn: esStored ? ['Mongo', 'Elasticsearch'] : ['Mongo'],
    reason: esStored
      ? `${inserted} usernames saved in Mongo and Elasticsearch.`
      : `${inserted} usernames saved in Mongo. Elasticsearch missed some batches, so run pnpm migrate:es once it is back.`,
  };
};
