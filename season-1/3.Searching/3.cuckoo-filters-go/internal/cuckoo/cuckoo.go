// Package cuckoo is a cuckoo filter: set membership with no false negatives, a tiny false positive rate, and delete.
// Same design as the Node version: 4 slots per bucket, partial-key cuckoo hashing, a "victim" kept aside when full.
package cuckoo

import (
	"crypto/sha256"
	"encoding/binary"
	"math"
	"math/rand/v2"
	"unsafe"
)

const (
	slots     = 4 // fingerprints per bucket
	maxKicks  = 500
	altMixer  = 0x5bd1e995
	maxLoad   = 0.9 // aim for at most ~90% full
	emptySlot = 0
)

type victim struct{ fp, i uint32 }

// Filter is NOT safe for concurrent writes. ponytail: the prototype builds it once at startup and only reads
// afterwards, which is safe. Add an RWMutex (or sharded locks) before Add runs while requests are served.
type Filter struct {
	fpBits  uint
	fpMask  uint32
	buckets uint32
	mask    uint32
	table   []uint32 // ponytail: a whole 32 bit cell per slot even if fpBits is smaller, bit-pack to cut RAM
	count   int
	victim  *victim // set when an insert runs out of kicks: the filter is full
}

// New sizes the filter for n items with fpBits (1..32) bits per fingerprint.
func New(n int, fpBits uint) *Filter {
	wanted := int(math.Ceil(float64(n) / slots / maxLoad))
	buckets := uint32(2) // power of 2, so the XOR in alt stays in range
	for int(buckets) < wanted {
		buckets <<= 1
	}
	mask := uint32(math.MaxUint32)
	if fpBits < 32 {
		mask = 1<<fpBits - 1
	}
	return &Filter{
		fpBits:  fpBits,
		fpMask:  mask,
		buckets: buckets,
		mask:    buckets - 1,
		table:   make([]uint32, int(buckets)*slots),
	}
}

// each item has two possible buckets: i1, and i2 = i1 XOR hash(fingerprint)
func (f *Filter) alt(i, fp uint32) uint32 { return (i ^ (fp * altMixer)) & f.mask }

func (f *Filter) locate(item string) (fp, i1, i2 uint32) {
	// read only view of the string's bytes: sha256 neither keeps nor changes them, so no copy per call
	d := sha256.Sum256(unsafe.Slice(unsafe.StringData(item), len(item)))
	fp = binary.LittleEndian.Uint32(d[0:4]) & f.fpMask
	if fp == emptySlot {
		fp = 1 // never 0, 0 means empty
	}
	i1 = binary.LittleEndian.Uint32(d[4:8]) & f.mask
	return fp, i1, f.alt(i1, fp)
}

func (f *Filter) find(i, fp uint32) bool {
	base := int(i) * slots
	for s := 0; s < slots; s++ {
		if f.table[base+s] == fp {
			return true
		}
	}
	return false
}

func (f *Filter) put(i, fp uint32) bool {
	base := int(i) * slots
	for s := 0; s < slots; s++ {
		if f.table[base+s] == emptySlot {
			f.table[base+s] = fp
			return true
		}
	}
	return false
}

// Add returns false when the filter is full (the item is still remembered in the victim).
func (f *Filter) Add(item string) bool {
	if f.victim != nil {
		return false
	}
	fp, i1, i2 := f.locate(item)
	if f.put(i1, fp) || f.put(i2, fp) {
		f.count++
		return true
	}
	i := i1
	if rand.IntN(2) == 1 {
		i = i2
	}
	for k := 0; k < maxKicks; k++ {
		slot := int(i)*slots + rand.IntN(slots)
		fp, f.table[slot] = f.table[slot], fp // kick a random resident out
		i = f.alt(i, fp)                      // its only other home
		if f.put(i, fp) {
			f.count++
			return true
		}
	}
	f.victim = &victim{fp: fp, i: i}
	f.count++
	return false
}

// Has: false is certain. true means "maybe". A full filter says "maybe" for everything and lets the DB decide.
func (f *Filter) Has(item string) bool {
	if f.victim != nil {
		return true
	}
	fp, i1, i2 := f.locate(item)
	return f.find(i1, fp) || f.find(i2, fp)
}

func (f *Filter) Count() int           { return f.count }
func (f *Filter) Buckets() int         { return int(f.buckets) }
func (f *Filter) FingerprintBits() int { return int(f.fpBits) }
func (f *Filter) SizeBytes() int       { return len(f.table) * 4 }
func (f *Filter) Full() bool           { return f.victim != nil }
func (f *Filter) LoadFactor() float64  { return float64(f.count) / float64(int(f.buckets)*slots) }

// ExpectedFalsePositiveRate is the textbook estimate: 2 buckets x 4 slots, each matching with chance 1 / 2^fpBits.
func (f *Filter) ExpectedFalsePositiveRate() float64 {
	return 2 * slots * f.LoadFactor() / math.Pow(2, float64(f.fpBits))
}
