import { FuseKeys } from '../shared/fuse.js';
import { Username } from '../features/usernames/usernames.model.js';
import { env } from './env.js';

// 16: about 6.8 MB for 30 lakh names, 0.0015% false positives. 8: about 3.4 MB, 0.39% (1 in 256 new names goes to the DB).
const FP_BITS = env.fpBits;

// A fuse filter cannot take new names, so it has two parts:
//   fuse  the big filter built from Mongo
//   delta names added since that build (a plain Set, small)
// Mutated in place (not replaced) so every importer always sees the current parts.
export const state = {
  fuse: new FuseKeys().build(FP_BITS),
  delta: new Set(),
  pending: null, // names added while a rebuild is running, they become the new delta
  builds: 0,
  lastBuildMs: 0,
  lastBuildStepMs: 0, // the part that blocks the event loop
};

export const mightContain = (name) => state.fuse.has(name) || state.delta.has(name);

export const noteAdded = (name) => {
  state.delta.add(name);
  state.pending?.add(name);
  // Every worker sees the same add lines, so they all cross the limit together and rebuild together.
  if (state.delta.size > env.deltaLimit) void rebuildFuse();
};

const buildOnce = async () => {
  const t0 = Date.now();
  state.pending = new Set();
  try {
    const keys = new FuseKeys();
    for await (const doc of Username.find().select('username -_id').lean().cursor()) keys.add(doc.username);
    // ponytail: this build step blocks the event loop (see lastBuildStepMs in /stats). Move it to a worker thread if that hurts.
    const t1 = Date.now();
    const fuse = keys.build(FP_BITS);
    state.lastBuildStepMs = Date.now() - t1;
    state.fuse = fuse;
    state.delta = state.pending; // whatever was added during the scan stays in the delta (a duplicate is harmless)
    state.builds++;
    state.lastBuildMs = Date.now() - t0;
    console.log(
      `Fuse rebuilt: ${fuse.keys} usernames, ${fuse.sizeBytes} bytes (${fuse.bitsPerKey.toFixed(2)} bits/key, ${FP_BITS} bit), ` +
        `${state.lastBuildMs} ms total, ${state.lastBuildStepMs} ms blocking, attempts=${fuse.attempts}`,
    );
  } finally {
    state.pending = null;
  }
};

let rebuilding = false;
let again = false;

// Mongo is the truth, so a restart (or a bulk ingest) can always rebuild the filter from it.
// A rebuild asked for while one is running is not dropped: it runs once more afterwards, because the scan may have missed those names.
export const rebuildFuse = async () => {
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
