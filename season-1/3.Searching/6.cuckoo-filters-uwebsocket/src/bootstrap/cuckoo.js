import { Cuckoo } from '../shared/cuckoo.js';
import { Username } from '../features/usernames/usernames.model.js';
import { env } from './env.js';

const build = () => new Cuckoo(env.expectedItems, 32); // 32 bit fingerprints: ~16.8 MB for 30 lakh names, false positives close to zero

// "let" on purpose: importers see the new filter after a rebuild swaps it in
export let cuckoo = build();

// Mongo is the truth, so a restart (or a bulk ingest) can always rebuild the filter from it.
export const rebuildCuckoo = async () => {
  const fresh = build();
  let count = 0;
  for await (const doc of Username.find().select('username -_id').lean().cursor()) {
    fresh.add(doc.username);
    count++;
  }
  cuckoo = fresh; // one step swap, nobody ever sees a half built filter
  console.log(`Cuckoo rebuilt: ${count} usernames, ${fresh.sizeBytes} bytes, load=${fresh.loadFactor.toFixed(3)}`);
  if (fresh.victim) console.warn('Cuckoo filter is FULL, every check will go to the DB. Raise EXPECTED_ITEMS and restart.');
};
