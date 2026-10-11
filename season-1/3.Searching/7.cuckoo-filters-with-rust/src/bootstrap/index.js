import { connectDatabase } from './database.js';
import { ensureEsIndex } from './elastic.js';
import { connectRedis } from './redis.js';
import { initCuckoo } from './cuckoo.js';

export const bootstrap = async () => {
  await connectDatabase();
  await ensureEsIndex(); // never blocks startup, ES down just means Mongo fallback
  await connectRedis(); // never blocks startup either
  await initCuckoo(); // maps the shared file, or builds it once from Mongo
};
