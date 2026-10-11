import { createHash } from 'node:crypto';

const SLOTS = 4; // fingerprints per bucket
const MAX_KICKS = 500;

export class Cuckoo {
  // n = expected items, fpBits = fingerprint size (more bits = fewer false positives, max 32)
  constructor(n, fpBits = 12) {
    this.fpBits = fpBits;
    this.fpMask = 2 ** fpBits - 1; // not (1 << fpBits) - 1, that breaks at 32 bits
    const wanted = Math.ceil(n / SLOTS / 0.9); // aim for at most ~90% full
    this.buckets = 2 ** Math.ceil(Math.log2(Math.max(wanted, 2))); // power of 2, so the XOR below stays in range
    this.mask = this.buckets - 1;
    // ponytail: a whole 16 or 32 bit cell per slot even when fpBits is smaller, bit-pack it to cut RAM
    const Cell = fpBits <= 16 ? Uint16Array : Uint32Array;
    this.table = new Cell(this.buckets * SLOTS); // 0 = empty slot
    this.count = 0;
    this.victim = null; // set when an insert runs out of kicks: the filter is full
  }

  // each item has two possible buckets: i1, and i2 = i1 XOR hash(fingerprint)
  #alt(i, fp) {
    return (i ^ (Math.imul(fp, 0x5bd1e995) >>> 0)) & this.mask;
  }

  #locate(item) {
    const d = createHash('sha256').update(item).digest();
    const fp = ((d.readUInt32LE(0) & this.fpMask) >>> 0) || 1; // never 0 (0 means empty), >>> 0 keeps 32 bit values positive
    const i1 = d.readUInt32LE(4) & this.mask;
    return { fp, i1, i2: this.#alt(i1, fp) };
  }

  #find(i, fp) {
    const base = i * SLOTS;
    for (let s = 0; s < SLOTS; s++) if (this.table[base + s] === fp) return base + s;
    return -1;
  }

  #put(i, fp) {
    const base = i * SLOTS;
    for (let s = 0; s < SLOTS; s++) {
      if (this.table[base + s] === 0) {
        this.table[base + s] = fp;
        return true;
      }
    }
    return false;
  }

  // false means the filter is full (the item is still remembered in `victim`)
  add(item) {
    if (this.victim) return false;
    let { fp, i1, i2 } = this.#locate(item);
    if (this.#put(i1, fp) || this.#put(i2, fp)) {
      this.count++;
      return true;
    }
    let i = Math.random() < 0.5 ? i1 : i2;
    for (let k = 0; k < MAX_KICKS; k++) {
      const slot = i * SLOTS + Math.floor(Math.random() * SLOTS);
      [fp, this.table[slot]] = [this.table[slot], fp]; // kick a random resident out
      i = this.#alt(i, fp); // its only other home
      if (this.#put(i, fp)) {
        this.count++;
        return true;
      }
    }
    this.victim = { fp, i };
    this.count++;
    return false;
  }

  has(item) {
    if (this.victim) return true; // full: answer "maybe" for everything and let the DB decide
    const { fp, i1, i2 } = this.#locate(item);
    return this.#find(i1, fp) >= 0 || this.#find(i2, fp) >= 0;
  }

  // only call for items that were really added, deleting a stranger can remove someone else's fingerprint
  delete(item) {
    const { fp, i1, i2 } = this.#locate(item);
    for (const i of [i1, i2]) {
      const at = this.#find(i, fp);
      if (at < 0) continue;
      this.table[at] = 0;
      this.count--;
      const v = this.victim;
      if (v && (this.#put(v.i, v.fp) || this.#put(this.#alt(v.i, v.fp), v.fp))) this.victim = null; // freed a slot, take the victim back
      return true;
    }
    return false;
  }

  get sizeBytes() {
    return this.table.byteLength;
  }

  get loadFactor() {
    return this.count / (this.buckets * SLOTS);
  }

  // textbook estimate: 2 buckets x 4 slots, each matching with chance 1 / 2^fpBits
  get expectedFalsePositiveRate() {
    return (2 * SLOTS * this.loadFactor) / 2 ** this.fpBits;
  }
}
