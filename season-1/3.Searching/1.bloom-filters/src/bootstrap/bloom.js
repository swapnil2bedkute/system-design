import { Bloom } from '../shared/bloom.js';
import { Username } from '../features/usernames/usernames.model.js';
import { env } from './env.js';

export const bloom = new Bloom(env.expectedItems, env.falsePositiveRate);

// Mongo is the truth, so a restart never loses the filter.
export const rebuildBloom = async () => {
  let count = 0;
  for await (const doc of Username.find().select('username -_id').lean().cursor()) {
    bloom.add(doc.username);
    count++;
  }
  console.log(`Bloom rebuilt: ${count} usernames, ${bloom.sizeBytes} bytes, k=${bloom.k}`);
};
