import { Filter } from '../shared/native.js';
import { env } from './env.js';

// One shared file: every PM2 process maps the same table, so RAM is paid once, not once per worker.
export const cuckoo = new Filter({
  path: env.cuckooFile,
  expectedItems: env.expectedItems,
  mongoUri: env.mongoUri,
  dbName: env.dbName,
  collection: 'usernames',
  redisUrl: env.redisUrl,
  stream: 'usernames:changes',
});

// Maps the file, or builds it from Mongo when it is missing or too small (only one worker builds, the rest wait).
export const initCuckoo = () => cuckoo.init();

// Mongo is the truth: a bulk ingest re-reads it into a new file and swaps it in. All workers pick the new file up by themselves.
export const rebuildCuckoo = async () => {
  const count = await cuckoo.rebuild();
  const s = cuckoo.stats();
  console.log(`Cuckoo rebuilt: ${count} usernames, ${s.sizeBytes} bytes, load=${s.loadFactor.toFixed(3)}`);
  if (s.full) console.warn('Cuckoo filter is FULL, every check will go to the DB. Raise EXPECTED_ITEMS and call rebuild.');
};
