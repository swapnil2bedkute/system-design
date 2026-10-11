import assert from 'node:assert';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Filter } from '../src/shared/native.js';

const N = 200000;
const open = async (path, expectedItems = N) => {
  const f = new Filter({ path, expectedItems }); // no mongoUri: starts empty
  await f.init();
  return f;
};

if (isMainThread) {
  const path = join(mkdtempSync(join(tmpdir(), 'cuckoo-')), 'f.bin');
  const f = await open(path);

  for (let i = 0; i < N; i++) assert(f.add(`user_${i}`), `filter full at user_${i}`);
  for (let i = 0; i < N; i++) assert(f.has(`user_${i}`), `missing user_${i}`); // no false negatives, ever
  let fp = 0;
  for (let i = 0; i < 500000; i++) if (f.has(`other_${i}`)) fp++;
  assert(fp === 0, `32 bit filter false positives: ${fp}`);
  assert.deepEqual(f.hasMany(['user_1', 'nope_1']), [true, false]);

  for (let i = 0; i < N; i += 2) assert(f.delete(`user_${i}`), `delete failed user_${i}`);
  for (let i = 1; i < N; i += 2) assert(f.has(`user_${i}`), `lost user_${i} after deletes`);
  let gone = 0;
  for (let i = 0; i < N; i += 2) if (!f.has(`user_${i}`)) gone++;
  assert(gone / (N / 2) > 0.99, 'deleted names still present');

  // a second Filter on the same file (what another PM2 process is) sees the same data
  const g = await open(path);
  assert(g.has('user_1') && !g.has('other_1'));
  g.add('from_g');
  assert(f.has('from_g'), 'write by one handle must be visible to the other');

  // overfill a tiny filter: it must say "maybe" for everything instead of lying
  const tiny = await open(join(mkdtempSync(join(tmpdir(), 'cuckoo-')), 't.bin'), 100);
  let rejected = 0;
  for (let i = 0; i < 2000; i++) if (!tiny.add(`t_${i}`)) rejected++;
  assert(rejected > 0 && tiny.stats().full && tiny.has('never_added'), 'tiny filter must fill up and answer maybe');

  // readers on other threads while this thread adds (kicks move fingerprints): they must never miss a name that is in
  const base = await open(join(mkdtempSync(join(tmpdir(), 'cuckoo-')), 'c.bin'), 400000);
  for (let i = 0; i < 150000; i++) base.add(`base_${i}`);
  const readers = Array.from({ length: 3 }, () => new Worker(new URL(import.meta.url), { workerData: { path: base.stats().path, n: 150000 } }));
  const misses = readers.map((w) => new Promise((r) => w.once('message', r)));
  for (let i = 0; i < 250000; i++) base.add(`more_${i}`); // pushes the load to ~100%, lots of kicks
  readers.forEach((w) => w.postMessage('stop'));
  const total = (await Promise.all(misses)).reduce((a, b) => a + b, 0);
  assert.equal(total, 0, `readers missed ${total} names that were in the filter`);

  const s = f.stats();
  console.log(`buckets=${s.buckets}, size=${s.sizeBytes} bytes, load=${s.loadFactor.toFixed(3)}, fp=0, concurrent misses=0`);
  console.log('ok');
} else {
  const r = await open(workerData.path);
  let stop = false;
  parentPort.once('message', () => (stop = true));
  let misses = 0;
  while (!stop) {
    for (let i = 0; i < 2000; i++) if (!r.has(`base_${(i * 7919) % workerData.n}`)) misses++;
    await new Promise((res) => setImmediate(res));
  }
  parentPort.postMessage(misses);
}
