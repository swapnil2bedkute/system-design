// Go prototype of the cuckoo username check: filter in RAM, Elasticsearch for "maybe", Mongo as fallback.
// Read path only (check-username, stats, fp-test), so it can be benchmarked against the Node version.
// Same Mongo data (bloom_demo.usernames) and ES index (usernames) as the Node projects.
package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"math/rand/v2"
	"net/http"
	"os"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	gojson "github.com/goccy/go-json"
	"github.com/gofiber/fiber/v2"
	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"

	"flipkart/internal/cuckoo"
)

const (
	esCooldown   = 10 * time.Second // after one ES failure skip ES for a while, go straight to Mongo
	esTimeout    = time.Second      // same as the Node version: fail fast, no retry
	mongoTimeout = 5 * time.Second
	fpBits       = 32
)

// validName is ^[A-Za-z0-9_]{3,30}$ without the regexp engine (this runs on every request).
func validName(s string) bool {
	if len(s) < 3 || len(s) > 30 {
		return false
	}
	for i := 0; i < len(s); i++ {
		b := s[i]
		if !(b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' || b >= '0' && b <= '9' || b == '_') {
			return false
		}
	}
	return true
}

// lowerASCII is strings.ToLower for an already validated name; it does not allocate when the name is already lower case.
func lowerASCII(s string) string {
	for i := 0; i < len(s); i++ {
		if s[i] >= 'A' && s[i] <= 'Z' {
			return strings.ToLower(s)
		}
	}
	return s
}

// writeCheck writes the check response straight into the body. Every part is a fixed phrase or the validated
// [a-z0-9_] username, so nothing needs JSON escaping, and there is no reflection and no encoder allocation.
// Same field order and text as the Node version.
func writeCheck(c *fiber.Ctx, username, result, filter, checkedIn, reason string) error {
	b := make([]byte, 0, 96+len(username)+len(reason)+len(checkedIn))
	b = append(b, `{"username":"`...)
	b = append(b, username...)
	b = append(b, `","result":"`...)
	b = append(b, result...)
	b = append(b, `","cuckooFilter":"`...)
	b = append(b, filter...)
	b = append(b, `","checkedIn":"`...)
	b = append(b, checkedIn...)
	b = append(b, `","reason":"`...)
	b = append(b, reason...)
	b = append(b, `"}`...)
	c.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
	return c.Send(b)
}

const reasonNew = "Cuckoo filter is sure this username was never added, so no database lookup was needed."

type server struct {
	filter    *cuckoo.Filter
	users     *mongo.Collection
	esURL     string
	esIndex   string
	hc        *http.Client
	downUntil atomic.Int64 // unix ms, ES is skipped until then

	// "checks" is not stored, stats adds the three up
	answeredByCuckoo, wentToEs, wentToMongo atomic.Int64
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if n, err := strconv.Atoi(os.Getenv(key)); err == nil && n > 0 {
		return n
	}
	return def
}

func badRequest(c *fiber.Ctx, msg string) error {
	return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": msg})
}

// ES _count for one username. Any error opens the breaker.
func (s *server) esCount(ctx context.Context, username string) (int64, error) {
	if time.Now().UnixMilli() < s.downUntil.Load() {
		return 0, fmt.Errorf("es breaker open")
	}
	// username is already validated as [A-Za-z0-9_], so it is safe to embed in the JSON as is
	body := `{"query":{"term":{"username":"` + username + `"}}}`
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.esURL+"/"+s.esIndex+"/_count", strings.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("content-type", "application/json")
	res, err := s.hc.Do(req)
	if err != nil {
		return 0, s.trip(err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body) // read it all so the connection goes back to the keep-alive pool
	if err != nil {
		return 0, s.trip(err)
	}
	if res.StatusCode != http.StatusOK {
		return 0, s.trip(fmt.Errorf("es status %d", res.StatusCode))
	}
	var out struct {
		Count int64 `json:"count"`
	}
	if err := gojson.Unmarshal(raw, &out); err != nil {
		return 0, s.trip(err)
	}
	return out.Count, nil
}

func (s *server) trip(err error) error {
	s.downUntil.Store(time.Now().Add(esCooldown).UnixMilli())
	log.Printf("ES unavailable, using Mongo for %s: %v", esCooldown, err)
	return err
}

func (s *server) mongoHas(ctx context.Context, username string) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, mongoTimeout)
	defer cancel()
	err := s.users.FindOne(ctx, bson.M{"username": username}, options.FindOne().SetProjection(bson.M{"_id": 1})).Err()
	if err == mongo.ErrNoDocuments {
		return false, nil
	}
	return err == nil, err
}

func (s *server) check(c *fiber.Ctx) error {
	raw := c.Query("username")
	if raw == "" {
		return badRequest(c, "querystring must have required property 'username'")
	}
	if !validName(raw) {
		return badRequest(c, `querystring/username must match pattern "^[A-Za-z0-9_]{3,30}$"`)
	}
	consistency := c.Query("consistency", "eventual")
	if consistency != "strong" && consistency != "eventual" {
		return badRequest(c, "querystring/consistency must be equal to one of the allowed values")
	}
	username := lowerASCII(raw)

	// filter says no: surely free, skip ES and Mongo
	if !s.filter.Has(username) {
		s.answeredByCuckoo.Add(1) // the only shared counter on this path: every extra atomic add is a cache line all cores fight over
		return writeCheck(c, username, "AVAILABLE", "Not present", "Not needed", reasonNew)
	}

	// filter says maybe: ES decides, Mongo if ES is down (could be a false positive).
	// consistency=strong forces Mongo even when ES is healthy.
	forceMongo := consistency == "strong"
	var taken, esOK bool
	var checkedIn, via string
	if !forceMongo {
		if count, err := s.esCount(c.Context(), username); err == nil {
			esOK, taken = true, count > 0
		}
	}
	if esOK {
		s.wentToEs.Add(1)
		checkedIn, via = "Elasticsearch", "Elasticsearch"
	} else {
		s.wentToMongo.Add(1)
		found, err := s.mongoHas(c.Context(), username)
		if err != nil {
			log.Printf("mongo: %v", err)
			return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"error": "database unavailable"})
		}
		taken, checkedIn, via = found, "Mongo", "Mongo (Elasticsearch is down)"
		if forceMongo {
			via = "Mongo"
		}
	}
	if taken {
		return writeCheck(c, username, "TAKEN", "Maybe present", checkedIn,
			"Cuckoo filter was unsure, so "+via+" was checked and this username exists there.")
	}
	return writeCheck(c, username, "AVAILABLE", "Maybe present", checkedIn,
		"Cuckoo filter was unsure (false alarm), so "+via+" was checked and this username does not exist there.")
}

func (s *server) stats(c *fiber.Ctx) error {
	hit := s.answeredByCuckoo.Load()
	return c.JSON(fiber.Map{
		"cuckoo": fiber.Map{
			"items":           s.filter.Count(),
			"buckets":         s.filter.Buckets(),
			"fingerprintBits": s.filter.FingerprintBits(),
			"sizeBytes":       s.filter.SizeBytes(),
			"loadFactor":      float64(int(s.filter.LoadFactor()*1000)) / 1000,
			"full":            s.filter.Full(),
		},
		"checks": fiber.Map{
			"checks": hit + s.wentToEs.Load() + s.wentToMongo.Load(), "answeredByCuckoo": hit,
			"wentToEs": s.wentToEs.Load(), "wentToMongo": s.wentToMongo.Load(), "dbCallsSaved": hit,
		},
	})
}

const letters = "abcdefghijklmnopqrstuvwxyz0123456789"

// Names never added, so every "maybe" is a false positive.
func (s *server) fpTest(c *fiber.Ctx) error {
	n := c.QueryInt("n", 10000)
	if n < 1 || n > 1000000 {
		return badRequest(c, "querystring/n must be between 1 and 1000000")
	}
	fp := 0
	buf := make([]byte, 15)
	copy(buf, "fp_")
	for i := 0; i < n; i++ {
		for j := 3; j < len(buf); j++ {
			buf[j] = letters[rand.IntN(len(letters))]
		}
		if s.filter.Has(string(buf)) {
			fp++
		}
	}
	return c.JSON(fiber.Map{"tested": n, "falsePositives": fp, "rate": float64(fp) / float64(n), "expected": s.filter.ExpectedFalsePositiveRate()})
}

// Mongo is the truth, so a restart always rebuilds the filter from it.
func rebuild(ctx context.Context, users *mongo.Collection, f *cuckoo.Filter) error {
	cur, err := users.Find(ctx, bson.D{}, options.Find().SetProjection(bson.M{"username": 1, "_id": 0}).SetBatchSize(10000))
	if err != nil {
		return err
	}
	defer cur.Close(ctx)
	var doc struct {
		Username string `bson:"username"`
	}
	for cur.Next(ctx) {
		if err := cur.Decode(&doc); err != nil {
			return err
		}
		f.Add(doc.Username)
	}
	return cur.Err()
}

// stopAfter is a test helper: EXIT_AFTER=120s makes the server stop itself, so a benchmark run never leaves a process behind.
func stopAfter(stop func()) {
	if d, err := time.ParseDuration(os.Getenv("EXIT_AFTER")); err == nil && d > 0 {
		time.AfterFunc(d, func() { log.Println("EXIT_AFTER reached, stopping"); stop() })
	}
}

func main() {
	// The heap is small (16 MB filter + a little garbage), so let it grow 4x before each GC instead of 2x. GOGC env still wins.
	if os.Getenv("GOGC") == "" {
		debug.SetGCPercent(400)
	}
	addr := ":" + env("CUCKOO_PORT", "3500")

	// PREFORK=1 runs one process per GOMAXPROCS, all sharing the port (like PM2 cluster). GOMAXPROCS=4 means 4 processes.
	// The parent only spawns and watches the children, each child builds its own filter, so the parent skips the setup below.
	// ponytail: every process holds its own filter, so add/delete (not built yet) would need the Redis stream sync like the Node version.
	prefork := os.Getenv("PREFORK") == "1"
	if prefork && !fiber.IsChild() {
		parent := fiber.New(fiber.Config{DisableStartupMessage: true, Prefork: true})
		stopAfter(func() { os.Exit(0) }) // the children have the same EXIT_AFTER, so they stop on their own too
		log.Printf("Parent %d starting %d child processes on %s", os.Getpid(), runtime.GOMAXPROCS(0), addr)
		if err := parent.Listen(addr); err != nil {
			log.Fatal(err)
		}
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	client, err := mongo.Connect(ctx, options.Client().ApplyURI(env("MONGO_URI", "mongodb://localhost:27017")).SetMaxPoolSize(100))
	if err == nil {
		err = client.Ping(ctx, nil)
	}
	cancel()
	if err != nil {
		log.Fatalf("mongo: %v", err)
	}

	s := &server{
		filter:  cuckoo.New(envInt("EXPECTED_ITEMS", 2000000), fpBits),
		users:   client.Database(env("DB_NAME", "bloom_demo")).Collection("usernames"),
		esURL:   strings.TrimRight(env("ES_URL", "http://127.0.0.1:9200"), "/"),
		esIndex: env("ES_INDEX", "usernames"),
		hc: &http.Client{
			Timeout:   esTimeout,
			Transport: &http.Transport{MaxIdleConns: 512, MaxIdleConnsPerHost: 512, IdleConnTimeout: 90 * time.Second},
		},
	}

	start := time.Now()
	if err := rebuild(context.Background(), s.users, s.filter); err != nil {
		log.Fatalf("rebuild: %v", err)
	}
	log.Printf("Cuckoo rebuilt: %d usernames, %d bytes, load=%.3f, full=%v, took %s",
		s.filter.Count(), s.filter.SizeBytes(), s.filter.LoadFactor(), s.filter.Full(), time.Since(start).Round(time.Millisecond))

	app := fiber.New(fiber.Config{JSONEncoder: gojson.Marshal, DisableStartupMessage: true, Prefork: prefork})
	app.Get("/check-username", s.check)
	app.Get("/stats", s.stats)
	app.Get("/fp-test", s.fpTest)
	stopAfter(func() { _ = app.Shutdown() })

	log.Printf("Listening on %s (pid %d, prefork child: %v)", addr, os.Getpid(), fiber.IsChild())
	if err := app.Listen(addr); err != nil {
		log.Fatal(err)
	}
}
