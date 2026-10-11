import assert from 'node:assert';
import { Bloom } from '../src/shared/bloom.js';

const N = 20000;
const bloom = new Bloom(N, 0.01);

for (let i = 0; i < N; i++) bloom.add(`user_${i}`);

// no false negatives, ever
for (let i = 0; i < N; i++) assert(bloom.has(`user_${i}`), `missing user_${i}`);

// false positives on names never added
const T = 10000;
let fp = 0;
for (let i = 0; i < T; i++) if (bloom.has(`other_${i}`)) fp++;
const rate = fp / T;

console.log(`m=${bloom.m} bits, k=${bloom.k}, size=${bloom.sizeBytes} bytes, fp=${(rate * 100).toFixed(2)}%`);
assert(rate < 0.02, `fp rate too high: ${rate}`);
console.log('ok');
