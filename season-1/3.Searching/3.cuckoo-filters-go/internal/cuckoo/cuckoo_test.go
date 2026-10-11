package cuckoo

import (
	"fmt"
	"testing"
)

func TestNoFalseNegativesAndLowFalsePositives(t *testing.T) {
	const n = 20000
	f := New(n, 32)
	for i := 0; i < n; i++ {
		if !f.Add(fmt.Sprintf("user_%d", i)) {
			t.Fatalf("filter full at user_%d", i)
		}
	}
	for i := 0; i < n; i++ {
		if !f.Has(fmt.Sprintf("user_%d", i)) {
			t.Fatalf("missing user_%d", i)
		}
	}
	fp := 0
	for i := 0; i < 200000; i++ {
		if f.Has(fmt.Sprintf("other_%d", i)) {
			fp++
		}
	}
	if fp != 0 {
		t.Fatalf("32 bit filter should have no false positives here, got %d", fp)
	}
}

func TestSmallFingerprintStillSafe(t *testing.T) {
	const n = 20000
	f := New(n, 12)
	for i := 0; i < n; i++ {
		f.Add(fmt.Sprintf("user_%d", i))
	}
	for i := 0; i < n; i++ {
		if !f.Has(fmt.Sprintf("user_%d", i)) {
			t.Fatalf("missing user_%d", i)
		}
	}
	fp := 0
	for i := 0; i < 100000; i++ {
		if f.Has(fmt.Sprintf("other_%d", i)) {
			fp++
		}
	}
	if rate := float64(fp) / 100000; rate > 0.01 {
		t.Fatalf("12 bit fp rate too high: %f", rate)
	}
}

func TestFullFilterAnswersMaybe(t *testing.T) {
	f := New(100, 16)
	rejected := 0
	for i := 0; i < 2000; i++ {
		if !f.Add(fmt.Sprintf("t_%d", i)) {
			rejected++
		}
	}
	if rejected == 0 || !f.Full() {
		t.Fatal("tiny filter should have filled up")
	}
	if !f.Has("never_added") {
		t.Fatal("a full filter must answer maybe")
	}
}
