import { env } from '../../bootstrap/env.js';
import { tryEs } from '../../bootstrap/elastic.js';
import { STREAM, pub, esReader } from '../../bootstrap/redis.js';

const ME = String(process.pid); // one PM2 worker = one consumer
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ops: add / del carry a username. The ES worker below consumes them; a filter rebuild replays them (see native/src/lib.rs).
export const publishChange = async (op, username = '', id = '') => {
  try {
    await pub.xAdd(STREAM, '*', { op, username, id: String(id) }, { TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: 100000 } });
    return true;
  } catch (err) {
    console.warn(`Redis publish failed (${op}): ${err.message}`);
    return false; // the filter file is already updated, only ES lags until migrate:es
  }
};

// One group: each line goes to ONE worker, which writes it to ES. Not acked = retried later.
// ponytail: add and del of the same name can reach two workers and finish out of order, rare and small.
export const startEsWorker = () => {
  (async () => {
    await esReader.xGroupCreate(STREAM, 'es', '0', { MKSTREAM: true }).catch(() => {}); // already exists is fine
    for (;;) {
      try {
        const stuck = await esReader.xAutoClaim(STREAM, 'es', ME, 30000, '0-0', { COUNT: 100 }); // unfinished for 30s+
        const fresh = await esReader.xReadGroup('es', ME, { key: STREAM, id: '>' }, { BLOCK: 5000, COUNT: 100 });
        const lines = [...stuck.messages, ...(fresh?.[0]?.messages ?? [])].filter(Boolean);
        let failed = false;
        for (const m of lines) {
          const { op, username, id } = m.message;
          if (op === 'add' || op === 'del') {
            const r = await tryEs((c) =>
              op === 'add' ? c.index({ index: env.esIndex, id, document: { username } }) : c.delete({ index: env.esIndex, id }, { ignore: [404] }),
            );
            if (!r.ok) {
              failed = true; // ES is down: leave it unacked, it is retried
              continue;
            }
          }
          await esReader.xAck(STREAM, 'es', m.id);
        }
        if (failed) await sleep(2000);
      } catch (err) {
        console.warn(`es worker: ${err.message}`);
        await sleep(2000);
      }
    }
  })();
};
