package main

import (
	"context"
	"errors"
	"log"
	"math"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	gojson "github.com/goccy/go-json"
	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/compress"
	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/bson/primitive"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
	"go.mongodb.org/mongo-driver/mongo/readpref"
	"go.mongodb.org/mongo-driver/x/mongo/driver/connstring"
)

const (
	defaultLimit = 20
	maxLimit     = 100

	// Fastify runs 4 pm2 workers x pool of 10 = 40 connections, so Go gets 40 for a fair comparison.
	// Min pool stays at the driver default (0), same as Mongoose.
	// ponytail: fixed number, make it an env var if you tune it per run.
	maxPoolSize = 40

	// Guards against one stuck Mongo query holding a request open. serverSelectionTimeout
	// (10s, in main()) already covers "cannot connect"; this covers "connected but stuck".
	queryTimeout = 5 * time.Second
)

// ponytail: createdAt/updatedAt use time.Time, so JSON drops trailing zero ms (.120Z -> .12Z). Add a custom marshaler if byte-identical output is needed.
type Product struct {
	ID          primitive.ObjectID `bson:"_id" json:"_id"`
	Name        string             `bson:"name" json:"name"`
	Description string             `bson:"description" json:"description"`
	Price       float64            `bson:"price" json:"price"`
	Stock       int64              `bson:"stock" json:"stock"`
	Category    string             `bson:"category" json:"category"`
	ImageURL    string             `bson:"imageUrl" json:"imageUrl"`
	CreatedAt   time.Time          `bson:"createdAt" json:"createdAt"`
	UpdatedAt   time.Time          `bson:"updatedAt" json:"updatedAt"`
	V           *int32             `bson:"__v,omitempty" json:"__v,omitempty"`
}

type offsetResp struct {
	Items      []Product `json:"items"`
	Page       int64     `json:"page"`
	Limit      int64     `json:"limit"`
	TotalItems int64     `json:"totalItems"`
	TotalPages int64     `json:"totalPages"`
}

type cursorResp struct {
	Items      []Product `json:"items"`
	NextCursor *string   `json:"nextCursor"`
}

// loadEnv reads KEY=VALUE lines from path. Real env vars win, a missing file is fine.
// ponytail: no export prefix, no multiline values. Swap in godotenv if .env grows.
func loadEnv(path string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		k, v, ok := strings.Cut(line, "=")
		if !ok || strings.HasPrefix(line, "#") {
			continue
		}
		k = strings.TrimSpace(k)
		if _, set := os.LookupEnv(k); !set {
			os.Setenv(k, strings.Trim(strings.TrimSpace(v), `"'`))
		}
	}
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func parseNum(raw string) (float64, bool) {
	n, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	return n, err == nil && !math.IsNaN(n) && !math.IsInf(n, 0)
}

// Invalid or <= 0 -> 20, capped at 100. Floor of 1 because Mongo limit(0) means "no limit".
func parseLimit(raw string) int64 {
	n, ok := parseNum(raw)
	if !ok || n <= 0 {
		return defaultLimit
	}
	return int64(math.Max(1, math.Min(n, maxLimit)))
}

// Invalid or < 1 -> 1. Capped so (page-1)*limit cannot overflow int64.
func parsePage(raw string) int64 {
	n, ok := parseNum(raw)
	if !ok || n < 1 {
		return 1
	}
	return int64(math.Min(n, 1e12))
}

func buildFilter(c *fiber.Ctx) bson.D {
	filter := bson.D{}
	if v := strings.TrimSpace(c.Query("category")); v != "" {
		filter = append(filter, bson.E{Key: "category", Value: v})
	}
	if term := strings.ReplaceAll(strings.TrimSpace(c.Query("name")), `"`, ""); term != "" {
		filter = append(filter, bson.E{Key: "$text", Value: bson.D{{Key: "$search", Value: term}}})
	}
	return filter
}

func find(ctx context.Context, col *mongo.Collection, filter bson.D, opts *options.FindOptions, limit int64) ([]Product, error) {
	// Non-nil slice so an empty result serializes as [] and not null.
	items := make([]Product, 0, limit)
	cur, err := col.Find(ctx, filter, opts)
	if err != nil {
		return nil, err
	}
	if err := cur.All(ctx, &items); err != nil {
		return nil, err
	}
	return items, nil
}

// GET /products?page=&limit=   -> offset pagination
// GET /products?cursor=&limit= -> cursor pagination (when no "page" param is given)
func list(col *mongo.Collection) fiber.Handler {
	return func(c *fiber.Ctx) error {
		ctx := c.UserContext()
		limit := parseLimit(c.Query("limit"))
		filter := buildFilter(c)

		qctx, cancel := context.WithTimeout(ctx, queryTimeout)
		defer cancel()

		opts := options.Find().SetSort(bson.D{{Key: "_id", Value: 1}}).SetLimit(limit)

		if c.Context().QueryArgs().Has("page") {
			page := parsePage(c.Query("page"))
			opts.SetSkip((page - 1) * limit)

			var (
				items             []Product
				total             int64
				findErr, countErr error
				wg                sync.WaitGroup
			)
			wg.Add(2)
			go func() {
				defer wg.Done()
				items, findErr = find(qctx, col, filter, opts, limit)
			}()
			go func() {
				defer wg.Done()
				// Same as the Node servers: whole-collection estimate, ignores the filter.
				total, countErr = col.EstimatedDocumentCount(qctx)
			}()
			wg.Wait()
			if findErr != nil {
				return findErr
			}
			if countErr != nil {
				return countErr
			}
			return c.JSON(offsetResp{
				Items:      items,
				Page:       page,
				Limit:      limit,
				TotalItems: total,
				TotalPages: (total + limit - 1) / limit,
			})
		}

		if cursor := c.Query("cursor"); cursor != "" {
			id, err := primitive.ObjectIDFromHex(cursor)
			if err != nil {
				return fiber.NewError(fiber.StatusBadRequest, "Invalid _id")
			}
			filter = append(filter, bson.E{Key: "_id", Value: bson.D{{Key: "$gt", Value: id}}})
		}
		items, err := find(qctx, col, filter, opts, limit)
		if err != nil {
			return err
		}
		var next *string
		if int64(len(items)) >= limit {
			hex := items[len(items)-1].ID.Hex()
			next = &hex
		}
		return c.JSON(cursorResp{Items: items, NextCursor: next})
	}
}

func isMongoDown(err error) bool {
	return mongo.IsTimeout(err) || mongo.IsNetworkError(err) ||
		strings.Contains(err.Error(), "server selection error")
}

func errorHandler(c *fiber.Ctx, err error) error {
	code, msg := fiber.StatusInternalServerError, "Something went wrong. Please try again later."
	var fe *fiber.Error
	switch {
	case errors.As(err, &fe):
		code, msg = fe.Code, fe.Message
		if code == fiber.StatusNotFound {
			msg = "Route " + c.Method() + " " + c.OriginalURL() + " not found"
		}
	case isMongoDown(err):
		c.Set(fiber.HeaderRetryAfter, "10")
		code, msg = fiber.StatusServiceUnavailable, "Service is temporarily unavailable. Please try again later."
	}
	return c.Status(code).JSON(fiber.Map{"error": msg})
}

func main() {
	loadEnv(".env")
	uri := env("MONGO_URI", "mongodb://127.0.0.1:27017/flip-commerce")
	cs, err := connstring.Parse(uri)
	if err != nil {
		log.Fatal(err)
	}
	if cs.Database == "" {
		log.Fatal("MONGO_URI must include a database name")
	}

	// No Ping at boot: if Mongo is down the server still starts and requests get 503.
	client, err := mongo.Connect(context.Background(), options.Client().ApplyURI(uri).
		SetMaxPoolSize(maxPoolSize).
		SetServerSelectionTimeout(10*time.Second).
		SetReadPreference(readpref.PrimaryPreferred()))
	if err != nil {
		log.Fatal(err)
	}

	app := fiber.New(fiber.Config{ErrorHandler: errorHandler, JSONEncoder: gojson.Marshal})
	// Picks gzip/brotli/deflate from the client's Accept-Encoding; level 1 like the other servers.
	app.Use(compress.New(compress.Config{Level: compress.LevelBestSpeed}))
	app.Get("/health", func(c *fiber.Ctx) error { return c.JSON(fiber.Map{"status": "ok"}) })
	app.Get("/products", list(client.Database(cs.Database).Collection("products")))
	log.Fatal(app.Listen(":" + env("PORT", "5005")))
}
