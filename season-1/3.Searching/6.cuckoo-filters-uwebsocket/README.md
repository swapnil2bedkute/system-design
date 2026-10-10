# Cuckoo filters on uWebSockets.js: username availability

Same app as the Fastify Cuckoo project (`2.cuckoo-filters`), with the HTTP server swapped for [uWebSockets.js](https://github.com/uNetworking/uWebSockets.js). Mongo is the truth. A Cuckoo filter in RAM answers "is this username free?" first, so most checks never reach Elasticsearch or Mongo. The filter, the Redis Stream sync and the ES retry are unchanged. The responses are byte for byte the same as the Fastify version for every endpoint that reads.

## Node version

uWebSockets.js ships a pre-built binary only for the **even** Node versions. **Node 22, 24 and 26 work. Node 23 and 25 do not** (odd, non-LTS releases never get a binary). `.nvmrc` pins 26.11.1, the newest supported one. Tested on 26.11.1 and 22.8.0.

```
nvm use          # reads .nvmrc (Node 26.11.1)
pnpm install
pnpm check       # cuckoo self-check, no DB
pnpm smoke       # HTTP layer test, no DB (validation, 404, body limit, keep-alive)
pnpm start       # needs Mongo on localhost:27017, Redis on 6379, Elasticsearch on 9200 (optional)
```

`package.json` installs uWebSockets.js from GitHub (it is not on npm). Its ESM wrapper is broken in v20.71.0, so `src/http/uws.js` loads the CommonJS entry with `createRequire`. Import uWS from there.

Env (all optional, defaults shown):

| Var | Default |
|---|---|
| `PORT` | `3800` |
| `WORKERS` | `4` worker threads |
| `MONGO_URI` | `mongodb://localhost:27017` |
| `EXPECTED_ITEMS` | `2000000` |
| `REDIS_URL` | `redis://127.0.0.1:6379` |
| `ES_URL` | `http://127.0.0.1:9200` |
| `ES_INDEX` | `usernames` |

Mongo DB is `bloom_demo` (collection `usernames`) and the ES index is `usernames`, shared with the other filter topics. Adds and deletes here change that shared data. The Redis stream is `usernames:uws-changes`, so only this project's workers see each other's changes.

## Endpoints

| Endpoint | What it does |
|---|---|
| `POST /add-username` | Insert into Mongo (`409` if taken), add to the filter and Elasticsearch |
| `GET /check-username?username=x` | Filter says no: free, no DB call. Filter says maybe: Elasticsearch confirms, Mongo if ES is down |
| `GET /check-username?username=x&consistency=strong` | Same, but a "maybe" is always confirmed in Mongo |
| `GET /check-username-in-db?username=x` | Always asks Mongo directly. No filter, no Elasticsearch |
| `DELETE /delete-username?username=x` | Remove from Mongo, the filter and Elasticsearch (`404` if unknown) |
| `POST /ingest?count=20000` | Insert random usernames in batches, then every worker rebuilds its filter from Mongo |
| `GET /stats` | Filter size, load factor, checks, DB calls saved (of the worker that answers) |
| `GET /fp-test?n=10000` | False positive rate on names never added |

```
curl -X POST localhost:3800/ingest
curl -X POST localhost:3800/add-username -H 'content-type: application/json' -d '{"username":"ankit_demo"}'
curl "localhost:3800/check-username?username=ankit_demo"
curl -X DELETE "localhost:3800/delete-username?username=ankit_demo"
curl localhost:3800/stats
```

## How it is built

- **Threads, not processes.** The main thread owns the port and passes every new connection to one of `WORKERS` worker threads (`addChildAppDescriptor`). Each worker is a full copy of the app: its own cuckoo filter, Mongo pool, Redis and ES connections. This works the same on macOS and Linux (several processes sharing a port with `SO_REUSEPORT` does not balance on macOS).
- **The hot path is synchronous.** `GET /check-username` for a new name is validated, checked against the filter and answered inside the uWS handler, with one prebuilt string. No promise, no JSON encoder, no router.
- **The slow paths are async** (ES, Mongo, body parsing). They use `handleAsync` in `src/http/helpers.js`, which respects the two uWS rules: read `req` before the first await, and do not write to a response whose client already left.
- **The controller knows no HTTP.** Every function in `usernames.controller.js` returns `{ status, body }`.
- Redis Stream sync, ES retry, rebuild after `ingest`: see the Cuckoo project. One consumer per worker thread (`pid-threadId`).

## Differences from the Fastify version

| What | Fastify version | This version |
|---|---|---|
| Responses of the endpoints above | | Identical (checked on 14 requests: status, content-type, body) |
| `404` for unknown routes and invalid JSON body | Fastify's own messages | `{"error":"Route not found"}`, `{"error":"body is not valid JSON"}` |
| Body limit | 100 KB | 4 KB (`add-username` only needs a name) |
| `/stats` and counters | one per PM2 worker | one per worker thread |
| Node versions | any | 22 or 24 |
| Delete and Elasticsearch | | Delete waits for ES to refresh (`wait_for`), so a check right after a delete never says `TAKEN` |

## Notes

- Restart rebuilds the filter from Mongo (all workers, so startup reads Mongo `WORKERS` times).
- During an ingest rebuild (seconds) the new names are not in the filter yet.
- If Elasticsearch is down during an ingest, its batches are not retried by the stream. Run `pnpm migrate:es` once ES is back.
