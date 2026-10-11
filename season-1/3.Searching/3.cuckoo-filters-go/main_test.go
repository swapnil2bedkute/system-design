package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	gojson "github.com/goccy/go-json"
	"github.com/gofiber/fiber/v2"
	"go.mongodb.org/mongo-driver/bson/primitive"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

// Runs without a real Mongo: port 1 refuses connections, so DB calls end in 503.
func TestErrors(t *testing.T) {
	client, err := mongo.Connect(context.Background(),
		options.Client().ApplyURI("mongodb://127.0.0.1:1").SetServerSelectionTimeout(300*time.Millisecond))
	if err != nil {
		t.Fatal(err)
	}
	app := fiber.New(fiber.Config{ErrorHandler: errorHandler})
	app.Get("/products", list(client.Database("x").Collection("products")))

	const down = `{"error":"Service is temporarily unavailable. Please try again later."}`
	cases := []struct {
		url  string
		code int
		body string
	}{
		{"/nope?a=1", 404, `{"error":"Route GET /nope?a=1 not found"}`},
		{"/products?cursor=zzz", 400, `{"error":"Invalid _id"}`},
		{"/products?limit=5", 503, down},
		{"/products?page=2", 503, down},
	}
	for _, tc := range cases {
		res, err := app.Test(httptest.NewRequest("GET", tc.url, nil), -1)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(res.Body)
		if res.StatusCode != tc.code || string(body) != tc.body {
			t.Errorf("%s: got %d %s, want %d %s", tc.url, res.StatusCode, body, tc.code, tc.body)
		}
		if tc.code == 503 && res.Header.Get("Retry-After") != "10" {
			t.Errorf("%s: missing Retry-After", tc.url)
		}
	}
}

func TestParseLimit(t *testing.T) {
	cases := map[string]int64{
		"": 20, "abc": 20, "0": 20, "-5": 20, "NaN": 20, "Inf": 20,
		"0.5": 1, "5.9": 5, "20": 20, " 7 ": 7, "500": 100,
	}
	for raw, want := range cases {
		if got := parseLimit(raw); got != want {
			t.Errorf("parseLimit(%q) = %d, want %d", raw, got, want)
		}
	}
}

func TestLoadEnv(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".env")
	os.WriteFile(path, []byte("# note\nLOADENV_A=one\nLOADENV_B=\"two\"\r\nLOADENV_C=file\nbadline\n"), 0o600)
	t.Setenv("LOADENV_C", "real")
	t.Cleanup(func() { os.Unsetenv("LOADENV_A"); os.Unsetenv("LOADENV_B") })

	loadEnv(path)
	loadEnv(filepath.Join(t.TempDir(), "missing.env"))

	for k, want := range map[string]string{"LOADENV_A": "one", "LOADENV_B": "two", "LOADENV_C": "real"} {
		if got := os.Getenv(k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}
}

// The app uses go-json. It must produce the same bytes as encoding/json.
func TestJSONParity(t *testing.T) {
	v := int32(0)
	resp := cursorResp{
		Items: []Product{
			{ID: primitive.NewObjectID(), Name: `Tab "quote" <b>`, Price: 1099.5, Stock: 10,
				CreatedAt: time.Date(2026, 8, 11, 2, 19, 57, 743e6, time.UTC),
				UpdatedAt: time.Date(2026, 8, 11, 2, 25, 40, 900e6, time.UTC), V: &v},
			{ID: primitive.NewObjectID(), Price: 10},
		},
	}
	want, _ := json.Marshal(resp)
	got, err := gojson.Marshal(resp)
	if err != nil || string(got) != string(want) {
		t.Errorf("go-json output differs\n got: %s\nwant: %s\nerr: %v", got, want, err)
	}
	empty, _ := gojson.Marshal(cursorResp{Items: []Product{}})
	if string(empty) != `{"items":[],"nextCursor":null}` {
		t.Errorf("empty response = %s", empty)
	}
}

func TestParsePage(t *testing.T) {
	cases := map[string]int64{
		"": 1, "abc": 1, "0": 1, "-3": 1, "NaN": 1, "2": 2, "2.9": 2, "1e30": 1e12,
	}
	for raw, want := range cases {
		if got := parsePage(raw); got != want {
			t.Errorf("parsePage(%q) = %d, want %d", raw, got, want)
		}
	}
}
