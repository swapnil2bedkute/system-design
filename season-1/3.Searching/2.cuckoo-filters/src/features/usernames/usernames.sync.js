import { cuckoo, rebuildCuckoo } from '../../bootstrap/cuckoo.js';
import { env } from '../../bootstrap/env.js';
import { tryEs } from '../../bootstrap/elastic.js';
import { STREAM, pub, filterReader, esReader } from '../../bootstrap/redis.js';

const ME = String(process.pid); // one PM2 worker = one consumer
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ops: add / del carry a username, rebuild means "bulk ingest happened, re-read Mongo"
export const publishChange = async (op, username = '', id = '') => {
  try {
    await pub.xAdd(STREAM, '*', { op, username, id: String(id) }, { TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: 100000 } });
    return true;
  } catch (err) {
    console.warn(`Redis publish failed (${op}): ${err.message}`);
    return false; // caller updates its own filter, the other workers stay behind until restart
  }
};

// Call BEFORE the Mongo rebuild. Anything that happens during the rebuild is replayed from here.
// A name added twice is harmless (a delete then leaves one stale copy, the DB still answers right). A missed add is not.
export const lastStreamId = async () => {
  try {
    const last = await Promise.race([filterReader.xRevRange(STREAM, '+', '-', { COUNT: 1 }), sleep(2000).then(() => { throw new Error('timeout'); })]);
    return last[0]?.id ?? '0-0';
  } catch {
    return '0-0'; // empty stream, or Redis down: replay what is there
  }
};

const apply = async ({ op, username }) => {
  if (op === 'add') cuckoo.add(username);
  // ponytail: skipping when absent avoids deleting a stranger's fingerprint, a false "present" can still slip through at ~0.01%
  else if (op === 'del') {
    if (cuckoo.has(username)) cuckoo.delete(username);
  } else if (op === 'rebuild') await rebuildCuckoo();
};

// Every worker runs this. It reads ALL changes in order and keeps its own filter in sync.
// ponytail: if a worker is down longer than the stream keeps (100k lines) it misses some, restart it to rebuild.
export const startFilterReader = (startId) => {
  (async () => {
    let last = startId;
    for (;;) {
      try {
        const res = await filterReader.xRead({ key: STREAM, id: last }, { BLOCK: 5000, COUNT: 500 });
        for (const m of res?.[0]?.messages ?? []) {
          await apply(m.message);
          last = m.id;
        }
      } catch (err) {
        console.warn(`filter reader: ${err.message}`);
        await sleep(2000);
      }
    }
  })();
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
