// Binary fuse filter (Graf and Lemire, 2022): the Xor filter's successor. Same trick (cell1 XOR cell2 XOR cell3 = fingerprint),
// but a key's 3 cells sit in 3 NEIGHBOURING segments of one array. That packs tighter (about 1.13 cells per key at 30 lakh
// names, Xor needs 1.23), builds faster and fails less often.
// Static: built once from ALL keys, no add or delete afterwards. Rebuild it when the set changes.
import { createHash } from 'node:crypto';

const GOLDEN = 0x9e3779b1;
const MAX_ATTEMPTS = 100; // a build fails now and then (some keys cannot be peeled), a new seed fixes it
const MAX_SEGMENT_LENGTH = 262144; // 2^18

// murmur3 finalizer: spreads every input bit over the whole 32 bit result
const mix32 = (h) => {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
};

// uniform number in [0, n) from a 32 bit value. The product is below 2^53 for n up to 2 million and just above for
// bigger n, then it rounds, which is harmless: build and lookup use this same function and the result stays below n.
const reduce = (x, n) => Math.floor((x * n) / 4294967296);

// Table shape for `size` keys. The two magic numbers are from the paper (they decide how often a build succeeds).
const layoutFor = (size) => {
  const segmentLength = size === 0 ? 4 : Math.min(2 ** Math.floor(Math.log(size) / Math.log(3.33) + 2.25), MAX_SEGMENT_LENGTH);
  const sizeFactor = size <= 1 ? 0 : Math.max(1.125, 0.875 + (0.25 * Math.log(1000000)) / Math.log(size));
  const capacity = size <= 1 ? 0 : Math.round(size * sizeFactor);
  const firstPass = (Math.ceil(capacity / segmentLength) - 2 + 2) * segmentLength;
  const rawCount = Math.ceil(firstPass / segmentLength);
  const segmentCount = rawCount <= 2 ? 1 : rawCount - 2;
  return {
    segmentLength,
    segmentCount,
    segmentCountLength: segmentCount * segmentLength, // where a key's first cell can start
    arrayLength: (segmentCount + 2) * segmentLength, // the other two cells sit 1 and 2 segments further
  };
};

// Where a key lives: one cell in each of 3 neighbouring segments, plus its fingerprint. Written into out[0..3].
const locate = (h1, h2, seed, layout, mask, out) => {
  const a = mix32(h1 ^ seed);
  const b = mix32(h2 + seed);
  const c = mix32(a ^ Math.imul(b, GOLDEN));
  const len = layout.segmentLength;
  const h0 = reduce(a, layout.segmentCountLength);
  out[0] = h0;
  out[1] = (h0 + len) ^ (b & (len - 1)); // next segment, offset inside it shuffled (len is a power of 2, so XOR stays inside)
  out[2] = (h0 + 2 * len) ^ (c & (len - 1)); // the segment after that
  out[3] = mix32(a ^ b ^ c ^ 0x7f4a7c15) & mask;
};

export class FuseFilter {
  #out = new Int32Array(4);

  constructor(fingerprints, layout, seed, fpBits, keys, attempts) {
    this.fingerprints = fingerprints;
    this.layout = layout;
    this.seed = seed;
    this.fpBits = fpBits;
    this.mask = 2 ** fpBits - 1;
    this.keys = keys;
    this.attempts = attempts;
  }

  // false is certain. true means "maybe".
  has(item) {
    const d = createHash('sha256').update(item).digest();
    const o = this.#out;
    locate(d.readUInt32LE(0), d.readUInt32LE(4), this.seed, this.layout, this.mask, o);
    const f = this.fingerprints;
    return (f[o[0]] ^ f[o[1]] ^ f[o[2]]) === o[3];
  }

  get sizeBytes() {
    return this.fingerprints.byteLength;
  }

  get bitsPerKey() {
    return this.keys ? (this.sizeBytes * 8) / this.keys : 0;
  }

  // a random key matches by chance 1 in 2^fpBits
  get expectedFalsePositiveRate() {
    return 2 ** -this.fpBits;
  }
}

// h1s / h2s: the two 32 bit halves of each key's hash. Keys must be distinct.
export const buildFuse = (h1s, h2s, n, fpBits = 16) => {
  if (fpBits < 1 || fpBits > 16) throw new RangeError('fpBits must be between 1 and 16');
  const Cell = fpBits <= 8 ? Uint8Array : Uint16Array;
  const mask = 2 ** fpBits - 1;
  const layout = layoutFor(n);
  const cells = layout.arrayLength;
  const H = new Int32Array(4);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const seed = Math.floor(Math.random() * 4294967296) | 0;

    // Per cell: t2count = (how many keys) * 4 + (XOR of which of the 3 hashes put a key there), xorIdx = XOR of their indexes.
    // With exactly one key left in a cell, both fields name that key and which of its 3 cells this is.
    const t2count = new Uint8Array(cells);
    const xorIdx = new Uint32Array(cells);
    let countMask = 0;
    for (let i = 0; i < n; i++) {
      locate(h1s[i], h2s[i], seed, layout, mask, H);
      for (let hi = 0; hi < 3; hi++) {
        const idx = H[hi];
        t2count[idx] += 4;
        t2count[idx] ^= hi;
        xorIdx[idx] ^= i;
        countMask |= t2count[idx];
      }
    }
    if (countMask >= 0x80) continue; // a counter overflowed (very rare), try another seed

    // peel: take a cell that holds one key, remove that key from its other two cells, repeat
    const alone = new Uint32Array(cells + 2);
    let q = 0;
    for (let s = 0; s < cells; s++) {
      alone[q] = s;
      q += t2count[s] >> 2 === 1 ? 1 : 0;
    }
    const order = new Uint32Array(n);
    const which = new Uint8Array(n);
    let sp = 0;
    while (q > 0) {
      q--;
      const s = alone[q];
      if (t2count[s] >> 2 !== 1) continue;
      const i = xorIdx[s];
      const f = t2count[s] & 3;
      order[sp] = i;
      which[sp] = f;
      sp++;
      locate(h1s[i], h2s[i], seed, layout, mask, H);
      const f1 = (f + 1) % 3;
      const i1 = H[f1];
      alone[q] = i1;
      q += t2count[i1] >> 2 === 2 ? 1 : 0;
      t2count[i1] -= 4;
      t2count[i1] ^= f1;
      xorIdx[i1] ^= i;
      const f2 = (f + 2) % 3;
      const i2 = H[f2];
      alone[q] = i2;
      q += t2count[i2] >> 2 === 2 ? 1 : 0;
      t2count[i2] -= 4;
      t2count[i2] ^= f2;
      xorIdx[i2] ^= i;
    }
    if (sp < n) continue; // stuck, try another seed

    // assign in reverse peel order, so each key's own cell is the only unknown
    const fingerprints = new Cell(cells);
    for (let k = n - 1; k >= 0; k--) {
      const i = order[k];
      const f = which[k];
      locate(h1s[i], h2s[i], seed, layout, mask, H);
      fingerprints[H[f]] = H[3] ^ fingerprints[H[(f + 1) % 3]] ^ fingerprints[H[(f + 2) % 3]];
    }
    return new FuseFilter(fingerprints, layout, seed, fpBits, n, attempt);
  }
  // ponytail: two different names with the same 64 bit hash would fail every attempt (odds ~1 in 10 million at 30 lakh names)
  throw new Error(`binary fuse build failed after ${MAX_ATTEMPTS} attempts, duplicate keys?`);
};

// Collects keys while they stream in (hashing as we go), then builds the filter.
export class FuseKeys {
  constructor(capacity = 1 << 16) {
    this.h1 = new Uint32Array(capacity);
    this.h2 = new Uint32Array(capacity);
    this.count = 0;
  }

  add(item) {
    if (this.count === this.h1.length) this.#grow();
    const d = createHash('sha256').update(item).digest();
    this.h1[this.count] = d.readUInt32LE(0);
    this.h2[this.count] = d.readUInt32LE(4);
    this.count++;
  }

  #grow() {
    const size = this.h1.length * 2;
    const a = new Uint32Array(size);
    const b = new Uint32Array(size);
    a.set(this.h1);
    b.set(this.h2);
    this.h1 = a;
    this.h2 = b;
  }

  build(fpBits = 16) {
    return buildFuse(this.h1, this.h2, this.count, fpBits);
  }
}
