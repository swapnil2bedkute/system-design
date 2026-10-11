import { randomBytes } from 'node:crypto';
import { state, mightContain } from '../../bootstrap/fuse.js';

// ponytail: in-memory counters, reset on restart
export const counters = { checks: 0, answeredByFuse: 0, wentToEs: 0, wentToMongo: 0, directToMongo: 0 };

export const getStats = () => ({
  fuse: {
    items: state.fuse.keys,
    deltaItems: state.delta.size,
    fingerprintBits: state.fuse.fpBits,
    sizeBytes: state.fuse.sizeBytes,
    bitsPerKey: Number(state.fuse.bitsPerKey.toFixed(2)),
    builds: state.builds,
    lastBuildMs: state.lastBuildMs,
    lastBuildBlockingMs: state.lastBuildStepMs,
  },
  checks: { ...counters, dbCallsSaved: counters.answeredByFuse },
});

// Names never added, so every "maybe" is a false positive.
export const fpTest = (n) => {
  let falsePositives = 0;
  for (let i = 0; i < n; i++) if (mightContain(`fp_${randomBytes(9).toString('base64url')}`)) falsePositives++;
  return { tested: n, falsePositives, rate: falsePositives / n, expected: Number(state.fuse.expectedFalsePositiveRate.toFixed(6)) };
};
