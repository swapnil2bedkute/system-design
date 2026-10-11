import { randomBytes } from 'node:crypto';
import { state, mightContain } from '../../bootstrap/xor.js';

// ponytail: in-memory counters, reset on restart
export const counters = { checks: 0, answeredByXor: 0, wentToEs: 0, wentToMongo: 0, directToMongo: 0 };

export const getStats = () => ({
  xor: {
    items: state.xor.keys,
    deltaItems: state.delta.size,
    fingerprintBits: state.xor.fpBits,
    sizeBytes: state.xor.sizeBytes,
    builds: state.builds,
    lastBuildMs: state.lastBuildMs,
  },
  checks: { ...counters, dbCallsSaved: counters.answeredByXor },
});

// Names never added, so every "maybe" is a false positive.
export const fpTest = (n) => {
  let falsePositives = 0;
  for (let i = 0; i < n; i++) if (mightContain(`fp_${randomBytes(9).toString('base64url')}`)) falsePositives++;
  return { tested: n, falsePositives, rate: falsePositives / n, expected: Number(state.xor.expectedFalsePositiveRate.toFixed(6)) };
};
