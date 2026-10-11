import assert from 'node:assert';
import { FuseKeys } from '../src/shared/fuse.js';

const build = (n, fpBits) => {
  const keys = new FuseKeys();
  for (let i = 0; i < n; i++) keys.add(`user_${i}`);
  return keys.build(fpBits);
};

// 16 bit: no false negatives, false positives near 2^-16 (0.0015%)
const N = 200000;
const f = build(N, 16);
for (let i = 0; i < N; i++) assert(f.has(`user_${i}`), `missing user_${i}`);
const T = 1000000;
let fp = 0;
for (let i = 0; i < T; i++) if (f.has(`other_${i}`)) fp++;
assert(fp / T < 0.0001, `16 bit fp rate too high: ${fp / T}`);
assert(f.bitsPerKey < 20, `16 bit filter too big: ${f.bitsPerKey} bits per key`);

// 8 bit: half the memory, false positives near 2^-8 (0.39%)
const f8 = build(N, 8);
for (let i = 0; i < N; i++) assert(f8.has(`user_${i}`), `8 bit missing user_${i}`);
let fp8 = 0;
for (let i = 0; i < 200000; i++) if (f8.has(`other_${i}`)) fp8++;
assert(fp8 / 200000 > 0.001 && fp8 / 200000 < 0.01, `8 bit fp rate off: ${fp8 / 200000}`);
assert(f8.bitsPerKey < 10, `8 bit filter too big: ${f8.bitsPerKey} bits per key`);

// tiny and empty sets must build too
for (const n of [0, 1, 2, 3, 10, 100, 1000]) {
  for (const bits of [8, 16]) {
    const s = build(n, bits);
    for (let i = 0; i < n; i++) assert(s.has(`user_${i}`), `tiny n=${n} bits=${bits} missing user_${i}`);
  }
}

// growth path of FuseKeys (starts at 65536 slots)
const big = build(150000, 16);
for (let i = 0; i < 150000; i += 7) assert(big.has(`user_${i}`), `grown missing user_${i}`);

// a build must not depend on luck: many different sizes, all succeed
for (const n of [5, 17, 99, 500, 4096, 12345, 70001]) {
  const s = build(n, 16);
  for (let i = 0; i < n; i++) assert(s.has(`user_${i}`), `size ${n} missing user_${i}`);
}

console.log(`16 bit: ${f.sizeBytes} bytes for ${N} keys (${f.bitsPerKey.toFixed(2)} bits/key), fp=${((fp / T) * 100).toFixed(4)}%, attempts=${f.attempts}`);
console.log(`8 bit : ${f8.sizeBytes} bytes (${f8.bitsPerKey.toFixed(2)} bits/key), fp=${((fp8 / 200000) * 100).toFixed(3)}%`);
console.log('ok');
