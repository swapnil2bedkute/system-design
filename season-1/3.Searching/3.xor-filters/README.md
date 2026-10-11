# Xor filters: username availability

Mongo is the truth. A Xor filter in RAM answers "is this username free?" first, so most checks never reach Elasticsearch or Mongo.

A Xor filter is **static**: it is built once from all the names and cannot add or delete afterwards. It is smaller and faster than Bloom and Cuckoo filters at the same accuracy, and this app copes with the static part like this:

| Part | What it holds |
|---|---|
| Xor filter (16 bit) | All names in Mongo at the last build, about 7.4 MB for 30 lakh names |
| New-names set | A plain `Set` with names added since that build |

A check asks both. The filter is rebuilt from Mongo on startup, after every `ingest`, and when the new-names set grows past `DELTA_LIMIT`.

## Run

```
pnpm install
pnpm check      # xor self-check, no DB
pnpm start      # needs Mongo on localhost:27017, Elasticsearch on 127.0.0.1:9200 (optional)
```

Env (all optional, defaults shown):

| Var | Default |
|---|---|
| `PORT` | `3600` |
| `MONGO_URI` | `mongodb://localhost:27017` |
| `DELTA_LIMIT` | `50000` |
| `REDIS_URL` | `redis://127.0.0.1:6379` |
| `ES_URL` | `http://127.0.0.1:9200` |
| `ES_INDEX` | `usernames` |

Mongo DB is `bloom_demo` (collection `usernames`) and the ES index is `usernames`, both shared with the bloom and cuckoo topics so the filters can be compared on the same data. Adds and deletes here change that shared data, and the other projects' filters do not see them until they restart.

## Endpoints

| Endpoint | What it does |
|---|---|
| `POST /add-username` | Insert into Mongo (`409` if taken), add to the new-names set and Elasticsearch |
| `GET /check-username?username=x` | Filter says no: free, no DB call. Filter says maybe: Elasticsearch confirms, Mongo if ES is down |
| `GET /check-username?username=x&consistency=strong` | Same, but a "maybe" is always confirmed in Mongo |
| `GET /check-username-in-db?username=x` | Always asks Mongo directly. No filter, no Elasticsearch |
| `DELETE /delete-username?username=x` | Remove from Mongo and Elasticsearch (`404` if unknown). The filter forgets it at the next rebuild |
| `POST /ingest?count=20000` | Insert random usernames in batches, then rebuild the filter |
| `GET /stats` | Filter size, new-names count, builds, checks, DB calls saved |
| `GET /fp-test?n=10000` | False positive rate on names never added |

```
curl -X POST localhost:3600/ingest
curl -X POST localhost:3600/add-username -H 'content-type: application/json' -d '{"username":"ankit_demo"}'
curl "localhost:3600/check-username?username=ankit_demo"
curl -X DELETE "localhost:3600/delete-username?username=ankit_demo"
curl localhost:3600/stats
curl "localhost:3600/fp-test?n=10000"
```

## How the filter works

- Every name gets 3 cells, one in each third of a table, and a 16 bit fingerprint.
- The table is filled so that `cell1 XOR cell2 XOR cell3 = fingerprint` for every name. A lookup is 3 reads and a compare.
- To fill it, cells that hold exactly one name are "peeled" off one by one, then the cells are assigned in reverse. If some names cannot be peeled the build retries with a new seed (usually the first try works).
- About 1.23 cells per name: 19.7 bits per name at 16 bit fingerprints, false positives 1 in 65,536. With 8 bit fingerprints it is half the memory and 1 in 256.
- A name deleted from Mongo stays in the filter until the next rebuild. A check for it says "maybe", asks the DB, and the DB gives the right answer. It is only a little slower.
- The build step blocks one worker for about a second. Move it to a worker thread if that matters.

## Keeping workers and Elasticsearch in sync (Redis Stream)

Each PM2 worker holds its own filter. Mongo writes are announced on the Redis stream `usernames:xor-changes`.

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
