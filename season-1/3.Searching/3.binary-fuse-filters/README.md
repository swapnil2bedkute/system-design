# Binary fuse filters: username availability

Mongo is the truth. A Binary Fuse filter in RAM answers "is this username free?" first, so most checks never reach Elasticsearch or Mongo.

A Binary Fuse filter is the Xor filter's successor. It is **static**: built once from all the names, no add or delete afterwards. It packs tighter and builds faster than a Xor filter, and this app copes with the static part like this:

| Part | What it holds |
|---|---|
| Fuse filter (16 or 8 bit) | All names in Mongo at the last build, about 6.8 MB (16 bit) or 3.4 MB (8 bit) for 30 lakh names |
| New-names set | A plain `Set` with names added since that build |

A check asks both. The filter is rebuilt from Mongo on startup, after every `ingest`, and when the new-names set grows past `DELTA_LIMIT`.

## Run

```
pnpm install
pnpm check      # fuse self-check, no DB
pnpm start      # needs Mongo on localhost:27017, Elasticsearch on 127.0.0.1:9200 (optional)
```

Env (all optional, defaults shown):

| Var | Default |
|---|---|
| `PORT` | `3700` |
| `FP_BITS` | `16` (use `8` for half the memory and 0.39% false positives) |
| `MONGO_URI` | `mongodb://localhost:27017` |
| `DELTA_LIMIT` | `50000` |
| `REDIS_URL` | `redis://127.0.0.1:6379` |
| `ES_URL` | `http://127.0.0.1:9200` |
| `ES_INDEX` | `usernames` |

Mongo DB is `bloom_demo` (collection `usernames`) and the ES index is `usernames`, shared with the other filter topics so the filters can be compared on the same data. Adds and deletes here change that shared data, and the other projects' filters do not see them until they restart.

## Endpoints

| Endpoint | What it does |
|---|---|
| `POST /add-username` | Insert into Mongo (`409` if taken), add to the new-names set and Elasticsearch |
| `GET /check-username?username=x` | Filter says no: free, no DB call. Filter says maybe: Elasticsearch confirms, Mongo if ES is down |
| `GET /check-username?username=x&consistency=strong` | Same, but a "maybe" is always confirmed in Mongo |
| `GET /check-username-in-db?username=x` | Always asks Mongo directly. No filter, no Elasticsearch |
| `DELETE /delete-username?username=x` | Remove from Mongo and Elasticsearch (`404` if unknown). The filter forgets it at the next rebuild |
| `POST /ingest?count=20000` | Insert random usernames in batches, then rebuild the filter |
| `GET /stats` | Filter size, bits per name, new-names count, builds, checks, DB calls saved |
| `GET /fp-test?n=10000` | False positive rate on names never added |

```
curl -X POST localhost:3700/ingest
curl -X POST localhost:3700/add-username -H 'content-type: application/json' -d '{"username":"ankit_demo"}'
curl "localhost:3700/check-username?username=ankit_demo"
curl -X DELETE "localhost:3700/delete-username?username=ankit_demo"
curl localhost:3700/stats
curl "localhost:3700/fp-test?n=10000"
```

## How the filter works

- Every name gets 3 cells and a fingerprint (16 or 8 bits). The table is filled so that `cell1 XOR cell2 XOR cell3 = fingerprint` for every name. A lookup is 3 reads and a compare.
- **What is new compared to a Xor filter:** the table is cut into segments, and a name's 3 cells sit in 3 neighbouring segments (first cell anywhere, the others one and two segments further, position inside the segment shuffled). Cells that hold many names are rare, so the table can be much fuller before the build gets stuck.
- Result: about 1.13 cells per name at 30 lakh names (Xor needs 1.23), so 18 bits per name at 16 bit fingerprints and 9 bits at 8 bit. The larger the set, the closer it gets to the 1.075 of the paper.
- To fill the table, cells that hold exactly one name are "peeled" off one by one, then the cells are assigned in reverse. If some names cannot be peeled the build retries with a new seed (usually the first try works).
- False positives are 1 in 2^bits: 1 in 65,536 (16 bit) or 1 in 256 (8 bit).
- A name deleted from Mongo stays in the filter until the next rebuild. A check for it says "maybe", asks the DB, and the DB gives the right answer. It is only a little slower.
- The build step blocks one worker for a moment (`lastBuildBlockingMs` in `/stats`). Move it to a worker thread if that matters.
- ponytail: the paper's build also sorts the keys by segment first, to be kinder to the CPU cache on huge sets. Skipped here, add it if builds of 10 crore names are slow.

## Keeping workers and Elasticsearch in sync (Redis Stream)

Each PM2 worker holds its own filter. Mongo writes are announced on the Redis stream `usernames:fuse-changes`.

| Event | What happens |
|---|---|
| `add-username` | Mongo save, then an `add` line. Every worker adds the name to its new-names set |
| `delete-username` | Mongo delete, then a `del` line. Only the ES worker uses it |
| `ingest` | One `rebuild` line. Every worker re-reads Mongo and rebuilds its filter |
| Elasticsearch | One worker per line writes it to ES. If ES is down the line stays unacked and is retried |

- Each worker remembers the last line it read, so a restart or a Redis blip does not lose changes.
- The stream keeps the last ~100k lines. A worker down longer than that should simply be restarted.
- Redis down: the request still works (Mongo is the truth), but other workers stay behind until they restart.

## Notes

- Restart rebuilds the filter from Mongo.
- During a rebuild (seconds) the old filter keeps answering. Names added meanwhile go to the new-names set.
- If Elasticsearch is down during an ingest, its batches are not retried by the stream. Run `pnpm migrate:es` once ES is back (it adds, it does not remove).
