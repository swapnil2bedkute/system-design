import { createClient } from 'redis';
import { env } from './env.js';

// own stream, so this project's workers never replay another filter project's changes (the ES group 'es' lives on the stream)
export const STREAM = 'usernames:fuse-changes';

const make = (opts = {}) => {
  const c = createClient({ url: env.redisUrl, ...opts });
  c.on('error', (err) => console.warn(`Redis: ${err.message}`)); // the client keeps reconnecting by itself
  return c;
};

// writer: fail fast when Redis is down, a request must never hang on it
export const pub = make({ disableOfflineQueue: true });
// readers block for seconds, so each one gets its own connection
export const filterReader = make();
export const esReader = make();

export const connectRedis = async () => {
  const all = [pub, filterReader, esReader].map((c) => c.connect().catch(() => {}));
  // do not hold startup hostage if Redis is down, the clients retry in the background
  await Promise.race([Promise.all(all), new Promise((r) => setTimeout(r, 2000))]);
};
