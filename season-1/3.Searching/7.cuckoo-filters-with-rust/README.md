# Cuckoo filters in Rust: username availability

Mongo is the truth. A Cuckoo filter in RAM answers "is this username free?" first, so most checks never reach Elasticsearch or Mongo. Unlike a Bloom filter, a Cuckoo filter can **delete**.

The filter is a Rust addon (`native/`, napi-rs) over a memory-mapped file (`data/cuckoo.bin`). Every PM2 process maps the same file, so the table is in RAM once, not once per worker.
Rust does has / add / delete / rebuild (Mongo) / stream replay. Node only calls it. Hash is xxh3, buckets are any number (no power of 2).

## Run

```
pnpm install
pnpm build:native   # cargo build --release, copies native/cuckoo_native.node (needs Rust)
pnpm check          # filter self-check, no DB (includes readers racing a writer)
pnpm start          # needs Mongo on localhost:27017, Elasticsearch on 127.0.0.1:9200 (optional)
```

Env (all optional, defaults shown):

| Var | Default |
|---|---|
| `PORT` | `3400` |
| `MONGO_URI` | `mongodb://localhost:27017` |
| `EXPECTED_ITEMS` | `2000000` |
| `REDIS_URL` | `redis://127.0.0.1:6379` |
| `ES_URL` | `http://127.0.0.1:9200` |
| `ES_INDEX` | `usernames` |
| `CUCKOO_FILE` | `./data/cuckoo.bin` |

`pnpm pm2` starts 4 processes on one port (`ecosystem.config.cjs`). The first one builds the file from Mongo, the others wait and map it.

Mongo DB is `bloom_demo` (collection `usernames`) and the ES index is `usernames`, both shared with the bloom topic so the two filters can be compared on the same data. Adds and deletes here change that shared data, and the bloom project's filter does not see them until it restarts.

## Endpoints

| Endpoint | What it does |
|---|---|
| `POST /add-username` | Insert into Mongo (`409` if taken), add to the filter and Elasticsearch |
| `GET /check-username?username=x` | Filter says no: free, no DB call. Filter says maybe: Elasticsearch confirms, Mongo if ES is down |
| `GET /check-username?username=x&consistency=strong` | Same, but a "maybe" is always confirmed in Mongo |
| `GET /check-username-in-db?username=x` | Always asks Mongo directly. No filter, no Elasticsearch |
| `DELETE /delete-username?username=x` | Remove from Mongo, the filter and Elasticsearch (`404` if unknown) |
| `POST /ingest?count=20000` | Insert random usernames in batches, add to the filter and Elasticsearch |
| `GET /stats` | Filter size, load factor, checks, DB calls saved |
| `GET /fp-test?n=10000` | False positive rate on names never added |

```
curl -X POST localhost:3400/ingest
curl -X POST localhost:3400/add-username -H 'content-type: application/json' -d '{"username":"ankit_demo"}'
curl "localhost:3400/check-username?username=ankit_demo"
curl -X DELETE "localhost:3400/delete-username?username=ankit_demo"
curl localhost:3400/stats
curl "localhost:3400/fp-test?n=10000"
```

## How the filter works

- Each item is stored as a small fingerprint (32 bits, set in `bootstrap/cuckoo.js`) in one of 2 buckets, 4 slots per bucket. More bits means fewer false positives and more memory: 16 bits is ~8.4 MB and ~0.008% false positives for 30 lakh names, 32 bits is ~16.8 MB and practically none.
- If both buckets are full, a resident is kicked to its other bucket, up to 500 times.
- Out of kicks means the filter is full. It then answers "maybe" for everything (safe, slower) and `/stats` shows `full: true`. Raise `EXPECTED_ITEMS` and restart.
- Delete is only safe for names that were really added, which is why `DELETE` removes from Mongo first.

## Keeping workers and Elasticsearch in sync (Redis Stream)

Each PM2 worker holds its own filter. Mongo writes are announced on the Redis stream `usernames:changes`.

| Event | What happens |
|---|---|
| `add-username` | Mongo save, then an `add` line. Every worker adds the name to its filter |
| `delete-username` | Mongo delete, then a `del` line. Every worker removes the name |
| `ingest` | One `rebuild` line. Every worker re-reads Mongo and rebuilds its filter |
| Elasticsearch | One worker per line writes it to ES. If ES is down the line stays unacked and is retried |

- Each worker remembers the last line it read, so a restart or a Redis blip does not lose changes.
- The stream keeps the last ~100k lines. A worker down longer than that should simply be restarted.
- Redis down: the request still works (Mongo is the truth), but other workers stay behind until they restart.

## Notes

- Restart rebuilds the filter from Mongo.
- During an ingest rebuild (seconds) the new names are not in the filter yet.
- If Elasticsearch is down during an ingest, its batches are not retried by the stream. Run `pnpm migrate:es` once ES is back (it adds, it does not remove).
