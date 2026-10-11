import { connectDatabase } from './database.js';
import { ensureEsIndex } from './elastic.js';
import { connectRedis } from './redis.js';
import { rebuildXor } from './xor.js';
import { lastStreamId } from '../features/usernames/usernames.sync.js';

export const bootstrap = async () => {
  await connectDatabase();
  await ensureEsIndex(); // never blocks startup, ES down just means Mongo fallback
  await connectRedis(); // never blocks startup either
  const startId = await lastStreamId(); // note the position first, then rebuild: nothing in between is lost
  await rebuildXor();
  return { startId };
};
