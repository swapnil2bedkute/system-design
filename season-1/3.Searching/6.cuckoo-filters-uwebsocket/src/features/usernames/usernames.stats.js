import { randomBytes } from 'node:crypto';
import { cuckoo } from '../../bootstrap/cuckoo.js';

// ponytail: in-memory counters, reset on restart
export const counters = { checks: 0, answeredByCuckoo: 0, wentToEs: 0, wentToMongo: 0, directToMongo: 0 };

export const getStats = () => ({
  cuckoo: {
    items: cuckoo.count,
    buckets: cuckoo.buckets,
    fingerprintBits: cuckoo.fpBits,
    sizeBytes: cuckoo.sizeBytes,
    loadFactor: Number(cuckoo.loadFactor.toFixed(3)),
    full: !!cuckoo.victim,
  },
  checks: { ...counters, dbCallsSaved: counters.answeredByCuckoo },
});

// Names never added, so every "maybe" is a false positive.
export const fpTest = (n) => {
  let falsePositives = 0;
  for (let i = 0; i < n; i++) if (cuckoo.has(`fp_${randomBytes(9).toString('base64url')}`)) falsePositives++;
  return { tested: n, falsePositives, rate: falsePositives / n, expected: Number(cuckoo.expectedFalsePositiveRate.toFixed(5)) };
};
