import { randomBytes } from 'node:crypto';
import { bloom } from '../../bootstrap/bloom.js';

// ponytail: in-memory counters, reset on restart
export const counters = { checks: 0, answeredByBloom: 0, wentToEs: 0, wentToMongo: 0 };

export const getStats = () => ({
  bloom: { items: bloom.count, bits: bloom.m, hashes: bloom.k, sizeBytes: bloom.sizeBytes, targetFalsePositiveRate: bloom.p },
  checks: { ...counters, dbCallsSaved: counters.answeredByBloom },
});

// Names never added, so every "maybe" is a false positive.
export const fpTest = (n) => {
  let falsePositives = 0;
  for (let i = 0; i < n; i++) if (bloom.has(`fp_${randomBytes(9).toString('base64url')}`)) falsePositives++;
  return { tested: n, falsePositives, rate: falsePositives / n, target: bloom.p };
};
