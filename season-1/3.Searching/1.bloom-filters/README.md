# Bloom filters: username availability

Mongo is the truth. A Bloom filter in RAM answers "is this username free?" first, so most checks never reach Mongo.

## Run

```
pnpm install
pnpm check      # bloom self-check, no DB
pnpm start      # needs Mongo on localhost:27017
```

Env (all optional, defaults shown):

| Var | Default |
|---|---|
| `PORT` | `3300` |
| `MONGO_URI` | `mongodb://localhost:27017` |
| `EXPECTED_ITEMS` | `20000` |

DB is `bloom_demo`, collection `usernames`, unique index on `username`.

## Endpoints

| Endpoint | What it does |
|---|---|
| `POST /add-username` | Insert into Mongo (`409` if taken), then add to bloom |
| `GET /check-username?username=x` | Bloom says no: free, no Mongo call. Bloom says maybe: Mongo confirms |
| `POST /ingest?count=20000` | Insert random usernames in batches and add to bloom |
| `GET /stats` | Bloom size, items, checks, Mongo calls saved |
| `GET /fp-test?n=10000` | False positive rate on names never added |

```
curl -X POST localhost:3300/ingest
curl -X POST localhost:3300/add-username -H 'content-type: application/json' -d '{"username":"ankit_demo"}'
curl "localhost:3300/check-username?username=ankit_demo"
curl localhost:3300/stats
curl "localhost:3300/fp-test?n=10000"
```

## Growing past 20k

1. Set `EXPECTED_ITEMS` to the new total (add ~10% buffer).
2. Restart the server. The bloom rebuilds from Mongo at the new size.
3. `curl -X POST "localhost:3300/ingest?count=<new names>"`

| Total | Bloom size (1% false positive) |
|---|---|
| 20k | ~24 KB |
| 1 lakh | ~120 KB |
| 10 lakh | ~1.2 MB |
| 1 crore | ~12 MB |

`/ingest` waits for the whole run and is capped at 1,000,000 per call. Beyond ~10 lakh, add a background job.

## Notes

- Bloom filters cannot delete. There is no delete endpoint.
- More items than `EXPECTED_ITEMS` raises the false positive rate. Raise it and restart.
- Counters in `/stats` reset on restart.
