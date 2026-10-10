package main

import (
	"io"
	"net/http/httptest"
	"testing"

	gojson "github.com/goccy/go-json"
	"github.com/gofiber/fiber/v2"

	"flipkart/internal/cuckoo"
)

func TestValidName(t *testing.T) {
	good := []string{"abc", "ABC", "a_b", "xdankit342", "u_k7ynekxo", "123", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
	bad := []string{"", "ab", "a b", "ab-cd", "naïve", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "a\"b", "abc\n"}
	for _, s := range good {
		if !validName(s) {
			t.Errorf("%q should be valid", s)
		}
	}
	for _, s := range bad {
		if validName(s) {
			t.Errorf("%q should be invalid", s)
		}
	}
}

func TestLowerASCII(t *testing.T) {
	for in, want := range map[string]string{"abc": "abc", "AbC": "abc", "U_K7": "u_k7", "x1": "x1"} {
		if got := lowerASCII(in); got != want {
			t.Errorf("lowerASCII(%q) = %q, want %q", in, got, want)
		}
	}
}

// The hand written JSON must parse and carry the same fields as before. Filter is empty, so no DB is touched.
func TestCheckResponseIsValidJSON(t *testing.T) {
	s := &server{filter: cuckoo.New(1000, 32)}
	app := fiber.New()
	app.Get("/check-username", s.check)

	res, err := app.Test(httptest.NewRequest("GET", "/check-username?username=Brand_New1", nil))
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 200 || res.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("status %d, content-type %q", res.StatusCode, res.Header.Get("Content-Type"))
	}
	raw, _ := io.ReadAll(res.Body)
	var got map[string]string
	if err := gojson.Unmarshal(raw, &got); err != nil {
		t.Fatalf("invalid JSON %s: %v", raw, err)
	}
	want := map[string]string{
		"username":     "brand_new1",
		"result":       "AVAILABLE",
		"cuckooFilter": "Not present",
		"checkedIn":    "Not needed",
		"reason":       reasonNew,
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q, want %q", k, got[k], v)
		}
	}
	if s.answeredByCuckoo.Load() != 1 {
		t.Errorf("answeredByCuckoo = %d, want 1", s.answeredByCuckoo.Load())
	}
}

func TestBadInputIs400(t *testing.T) {
	s := &server{filter: cuckoo.New(1000, 32)}
	app := fiber.New()
	app.Get("/check-username", s.check)
	for _, url := range []string{"/check-username", "/check-username?username=ab", "/check-username?username=abcd&consistency=xyz"} {
		res, err := app.Test(httptest.NewRequest("GET", url, nil))
		if err != nil || res.StatusCode != 400 {
			t.Errorf("%s: want 400, got %v %v", url, res.StatusCode, err)
		}
	}
}
