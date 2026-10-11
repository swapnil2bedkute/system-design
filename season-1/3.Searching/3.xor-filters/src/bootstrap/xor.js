import { XorKeys } from '../shared/xor.js';
import { Username } from '../features/usernames/usernames.model.js';
import { env } from './env.js';

const FP_BITS = 16; // 7.4 MB for 30 lakh names, 0.0015% false positives. 8 gives half the memory and 0.39%.

// A xor filter cannot take new names, so it has two parts:
//   xor   the big filter built from Mongo
//   delta names added since that build (a plain Set, small)
// Mutated in place (not replaced) so every importer always sees the current parts.
export const state = {
  xor: new XorKeys().build(FP_BITS),
  delta: new Set(),
  pending: null, // names added while a rebuild is running, they become the new delta
  builds: 0,
  lastBuildMs: 0,
};

export const mightContain = (name) => state.xor.has(name) || state.delta.has(name);

export const noteAdded = (name) => {
  state.delta.add(name);
  state.pending?.add(name);
  // Every worker sees the same add lines, so they all cross the limit together and rebuild together.
  if (state.delta.size > env.deltaLimit) void rebuildXor();
};

const buildOnce = async () => {
  const t0 = Date.now();
  state.pending = new Set();
  try {
    const keys = new XorKeys();
    for await (const doc of Username.find().select('username -_id').lean().cursor()) keys.add(doc.username);
    // ponytail: this build step blocks the event loop for about a second. Move it to a worker thread if that hurts.
    const xor = keys.build(FP_BITS);
    state.xor = xor;
    state.delta = state.pending; // whatever was added during the scan stays in the delta (a duplicate is harmless)
    state.builds++;
    state.lastBuildMs = Date.now() - t0;
    console.log(`Xor rebuilt: ${xor.keys} usernames, ${xor.sizeBytes} bytes, ${state.lastBuildMs} ms, attempts=${xor.attempts}`);
  } finally {
    state.pending = null;
  }
};

let rebuilding = false;
let again = false;

// Mongo is the truth, so a restart (or a bulk ingest) can always rebuild the filter from it.
// A rebuild asked for while one is running is not dropped: it runs once more afterwards, because the scan may have missed those names.
export const rebuildXor = async () => {
  if (rebuilding) {
    again = true;
    return;
  }
  rebuilding = true;
  try {
    do {
      again = false;
      await buildOnce();
    } while (again);
  } finally {
    rebuilding = false;
  }
};
