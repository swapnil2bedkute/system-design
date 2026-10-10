import { createHash } from 'node:crypto';

export class Bloom {
  // n = expected items, p = target false positive rate
  constructor(n, p = 0.01) {
    this.p = p;
    this.m = Math.ceil((-n * Math.log(p)) / Math.LN2 ** 2); // bits
    this.k = Math.max(1, Math.round((this.m / n) * Math.LN2)); // hashes
    this.bits = new Uint8Array(Math.ceil(this.m / 8));
    this.count = 0; // add() calls, duplicates included
  }

  // ponytail: double hashing from one sha256, swap for murmur if hashing gets slow
  #positions(item) {
    const d = createHash('sha256').update(item).digest();
    const h1 = d.readUInt32LE(0);
    const h2 = (d.readUInt32LE(4) | 1) >>> 0; // >>> 0 keeps it unsigned
    return Array.from({ length: this.k }, (_, i) => (h1 + i * h2) % this.m);
  }

  add(item) {
    this.count++;
    for (const pos of this.#positions(item)) this.bits[pos >> 3] |= 1 << (pos & 7);
  }

  has(item) {
    return this.#positions(item).every((pos) => this.bits[pos >> 3] & (1 << (pos & 7)));
  }

  get sizeBytes() {
    return this.bits.length;
  }
}
