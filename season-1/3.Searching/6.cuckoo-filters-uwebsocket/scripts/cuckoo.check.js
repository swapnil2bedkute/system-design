import assert from 'node:assert';
import { Cuckoo } from '../src/shared/cuckoo.js';

const N = 20000;
const f = new Cuckoo(N);

for (let i = 0; i < N; i++) assert(f.add(`user_${i}`), `filter full at user_${i}`);

// no false negatives, ever
for (let i = 0; i < N; i++) assert(f.has(`user_${i}`), `missing user_${i}`);

// false positives on names never added
const T = 10000;
let fp = 0;
for (let i = 0; i < T; i++) if (f.has(`other_${i}`)) fp++;
assert(fp / T < 0.01, `fp rate too high: ${fp / T}`);

// delete the first half: gone (almost), the second half untouched
for (let i = 0; i < N / 2; i++) assert(f.delete(`user_${i}`), `delete failed user_${i}`);
let stillThere = 0;
for (let i = 0; i < N / 2; i++) if (f.has(`user_${i}`)) stillThere++;
assert(stillThere / (N / 2) < 0.01, `deleted names still present: ${stillThere}`);
for (let i = N / 2; i < N; i++) assert(f.has(`user_${i}`), `lost user_${i} after deletes`);

// 32 bit fingerprints: same guarantees, and (almost) no false positives
const wide = new Cuckoo(N, 32);
assert(wide.table instanceof Uint32Array, '32 bit filter needs 32 bit cells');
for (let i = 0; i < N; i++) assert(wide.add(`user_${i}`), `wide filter full at user_${i}`);
for (let i = 0; i < N; i++) assert(wide.has(`user_${i}`), `wide missing user_${i}`);
let wideFp = 0;
for (let i = 0; i < 200000; i++) if (wide.has(`other_${i}`)) wideFp++;
assert(wideFp === 0, `32 bit filter false positives: ${wideFp}`);
for (let i = 0; i < N; i += 2) assert(wide.delete(`user_${i}`), `wide delete failed user_${i}`);
for (let i = 1; i < N; i += 2) assert(wide.has(`user_${i}`), `wide lost user_${i} after deletes`);

// overfill a tiny filter: it must say "maybe" for everything instead of lying
const tiny = new Cuckoo(100);
let rejected = 0;
for (let i = 0; i < 2000; i++) if (!tiny.add(`t_${i}`)) rejected++;
assert(rejected > 0 && tiny.victim, 'tiny filter should have filled up');
assert(tiny.has('never_added'), 'full filter must answer maybe');

console.log(`buckets=${f.buckets}, fpBits=${f.fpBits}, size=${f.sizeBytes} bytes, fp=${((fp / T) * 100).toFixed(3)}%`);
console.log('ok');
