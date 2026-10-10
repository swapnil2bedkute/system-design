// Xor filter (Graf and Lemire): set membership with no false negatives, about 1.23 cells per key, 3 reads per lookup.
// It is built once from ALL keys and cannot add or delete afterwards. Rebuild it when the set changes.
import { createHash } from 'node:crypto';

const GOLDEN = 0x9e3779b1;
const MAX_ATTEMPTS = 20; // a build fails now and then (some keys cannot be peeled), a new seed fixes it

// murmur3 finalizer: spreads every input bit over the whole 32 bit result
const mix32 = (h) => {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
};

// uniform number in [0, n) from a 32 bit value. Exact because x * n stays below 2^53.
const reduce = (x, n) => Math.floor((x * n) / 4294967296);

// Where a key lives: one cell in each of the 3 blocks, plus its fingerprint. Written into out[0..3].
const locate = (h1, h2, seed, blockLength, mask, out) => {
  const a = mix32(h1 ^ seed);
  const b = mix32(h2 + seed);
  const c = mix32(a ^ Math.imul(b, GOLDEN));
  out[0] = reduce(a, blockLength);
  out[1] = blockLength + reduce(b, blockLength);
  out[2] = 2 * blockLength + reduce(c, blockLength);
  out[3] = mix32(a ^ b ^ c ^ 0x7f4a7c15) & mask;
};

export class XorFilter {
  #out = new Int32Array(4);

  constructor(fingerprints, blockLength, seed, fpBits, keys, attempts) {
    this.fingerprints = fingerprints;
    this.blockLength = blockLength;
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
    locate(d.readUInt32LE(0), d.readUInt32LE(4), this.seed, this.blockLength, this.mask, o);
    const f = this.fingerprints;
    return (f[o[0]] ^ f[o[1]] ^ f[o[2]]) === o[3];
  }

  get sizeBytes() {
    return this.fingerprints.byteLength;
  }

  // a random key matches by chance 1 in 2^fpBits
  get expectedFalsePositiveRate() {
    return 2 ** -this.fpBits;
  }
}

// h1s / h2s: the two 32 bit halves of each key's hash. Keys must be distinct.
export const buildXor = (h1s, h2s, n, fpBits = 16) => {
  if (fpBits < 1 || fpBits > 16) throw new RangeError('fpBits must be between 1 and 16');
  const Cell = fpBits <= 8 ? Uint8Array : Uint16Array;
  const mask = 2 ** fpBits - 1;
  const blockLength = Math.floor((Math.floor(1.23 * n) + 32) / 3);
  const cells = blockLength * 3;
  const out = new Int32Array(4);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const seed = Math.floor(Math.random() * 4294967296) | 0;

    // every key sits in 3 cells. Per cell: how many keys, and the XOR of their indexes.
    const count = new Uint32Array(cells);
    const xorIdx = new Uint32Array(cells);
    for (let i = 0; i < n; i++) {
      locate(h1s[i], h2s[i], seed, blockLength, mask, out);
      for (let t = 0; t < 3; t++) {
        count[out[t]]++;
        xorIdx[out[t]] ^= i;
      }
    }

    // peel: a cell with exactly one key tells us that key (xorIdx). Remove it, repeat.
    const queue = new Uint32Array(cells); // a cell reaches count 1 at most once, so this never overflows
    let head = 0;
    let tail = 0;
    for (let s = 0; s < cells; s++) if (count[s] === 1) queue[tail++] = s;
    const stackKey = new Uint32Array(n);
    const stackCell = new Uint32Array(n);
    let sp = 0;
    while (head < tail) {
      const s = queue[head++];
      if (count[s] !== 1) continue;
      const i = xorIdx[s];
      stackKey[sp] = i;
      stackCell[sp] = s;
      sp++;
      locate(h1s[i], h2s[i], seed, blockLength, mask, out);
      for (let t = 0; t < 3; t++) {
        const p = out[t];
        count[p]--;
        xorIdx[p] ^= i;
        if (count[p] === 1) queue[tail++] = p;
      }
    }
    if (sp < n) continue; // stuck, try another seed

    // assign in reverse peel order, so each key's own cell is the only unknown: xor of its 3 cells = its fingerprint
    const fingerprints = new Cell(cells);
    for (let k = n - 1; k >= 0; k--) {
      const i = stackKey[k];
      locate(h1s[i], h2s[i], seed, blockLength, mask, out);
      fingerprints[stackCell[k]] = out[3] ^ fingerprints[out[0]] ^ fingerprints[out[1]] ^ fingerprints[out[2]];
    }
    return new XorFilter(fingerprints, blockLength, seed, fpBits, n, attempt);
  }
  // ponytail: two different names with the same 64 bit hash would fail every attempt (odds ~1 in 10 million at 30 lakh names)
  throw new Error(`xor filter build failed after ${MAX_ATTEMPTS} attempts, duplicate keys?`);
};

// Collects keys while they stream in (hashing as we go), then builds the filter.
export class XorKeys {
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
    return buildXor(this.h1, this.h2, this.count, fpBits);
  }
}
