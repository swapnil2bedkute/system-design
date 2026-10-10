# Flipkart API

Modular ecommerce backend. Products, Cart, Wishlist. TypeScript, Fastify, Mongoose, cursor pagination, pm2, Swagger.

## Stack

| Piece | Choice |
|---|---|
| Language | TypeScript ^7.0.2 |
| HTTP | Fastify 5 |
| Database | MongoDB replica set `fk-rs` (Docker) + Mongoose, `w: majority` |
| Cache (reserved, not wired into features yet) | Redis (official `redis` client) |
| Env validation | zod |
| Logging | winston (console + `logs/*.log` file transports) |
| Build | tsup (esbuild) — minified in both dev and prod |
| Process manager | node:cluster (`WORKERS`, default 1) |
| API docs | swagger-jsdoc + @fastify/swagger-ui |

## Folder structure

```
infra/mongo/               # Docker replica set — 1 primary + 2 secondary (app not in compose)
src/
├── server.ts              # bootstrap() → app.listen → graceful shutdown wiring
├── app.ts                 # fastify app: helmet, cors, compression, routers, /health, /api-docs
├── bootstrap/              # everything that runs at startup, one concern per file
│   ├── env.ts              # zod-validated env
│   ├── logger.ts            # winston logger
│   ├── database.ts          # mongoose connect/disconnect
│   ├── redis.ts             # redis client connect/disconnect (unused for now)
│   ├── shutdown.ts          # uncaughtException/unhandledRejection + SIGINT/SIGTERM
│   └── index.ts             # orchestrator — env → logger → database → redis → shutdown
├── shared/
│   ├── error.ts             # httpError, notFound, errorHandler (incl. CastError → 400)
│   └── pagination.ts        # cursor helpers, MAX_LIMIT=100, DEFAULT_LIMIT=20
├── docs/swagger.ts          # swagger-jsdoc spec (reads @openapi comments in *.router.ts)
├── features/
│   ├── products/            # model / types / validation / controller / router
│   ├── cart/                 # same 5-file pattern
│   └── wishlist/             # same 5-file pattern (no PUT — nothing to update)
└── seed/seed-products.ts    # bulk product seeder
```

No `*.service.ts` files — controllers call Mongoose models directly (deliberate, no service layer for this project's scope).

## Setup

```bash
pnpm install
cp .env.example .env   # already created, adjust values if needed
```

### Env vars (`.env`, validated by `src/bootstrap/env.ts`)

| Var | Default | Notes |
|---|---|---|
| `PORT` | 5003 | |
| `MONGO_URI` | replica URI, DB `fk-app` | `replicaSet=fk-rs&w=majority&readPreference=primaryPreferred` |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Client connects at boot, not yet used by any feature |
| `LOG_LEVEL` | `info` | `error` \| `warn` \| `info` \| `http` \| `debug` |
| `NODE_ENV` | `development` | `development` \| `production` \| `test` |

Invalid/missing required env values fail fast at startup with a clear error.

## Mongo replica set (Docker)

Compose me **sirf Mongo**. App host pe independent (`pnpm dev` / pm2).

| Node | Container | Host port | Volume |
|---|---|---|---|
| Primary | `fk-mongo-primary` | 27017 | `fk-mongo-primary-data` |
| Secondary | `fk-mongo-secondary-1` | 27018 | `fk-mongo-secondary-1-data` |
| Secondary | `fk-mongo-secondary-2` | 27019 | `fk-mongo-secondary-2-data` |

Replica set: `fk-rs`. App DB: `fk-app`. Test DB: `fk-test` (same cluster). Write concern: `w: majority`. Read: `primaryPreferred` (PRIMARY nahi to last SECONDARY se read).

```bash
pnpm mongo:up       # start (reuses volumes)
pnpm mongo:status   # 1 PRIMARY, 2 SECONDARY
pnpm mongo:down     # stop, data rehti
pnpm mongo:reset    # data mitati + dubara init
```

Host pe pehle se `mongod` 27017 pe ho to band karo, warna primary port bind fail.

App `host.docker.internal` ko `127.0.0.1` map karti hai (Mac pe wo DNS nahi milta). Compass/mongosh se replica set connect karna ho to `/etc/hosts` me ye line:

`127.0.0.1 host.docker.internal`

Init: `fk-mongo-init` ek baar `rs.initiate` chalata hai (already initiated ho to skip), phir exit.

Docker Desktop (Linux VM kernel 6.19+) pe Mongo 8 ko `GLIBC_TUNABLES=glibc.pthread.rseq=1` chahiye — compose me already set (SERVER-121912).

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | tsup watch build (minified) → runs `dist/server.js`, rebuilds + restarts on change |
| `pnpm build` | one-off tsup build (not minified, has sourcemaps) |
| `pnpm build:prod` | tsup build, minified, `dist/` cleaned first |
| `pnpm start:prod` | `build:prod` then runs `dist/server.js` with `NODE_ENV=production` |
| `pnpm seed:products` | builds + runs the bulk product seeder |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm mongo:up` | start replica set (`infra/mongo/compose.yaml`) |
| `pnpm mongo:down` | stop containers — **volumes stay** |
| `pnpm mongo:status` | compact replica roles (PRIMARY / SECONDARY / DOWN) |
| `pnpm mongo:reset` | wipe volumes + start fresh — **only this deletes data** |
| `pnpm es:up` | start Elasticsearch (`infra/elasticsearch/compose.yaml`, volume `fk-es-data`) |
| `pnpm es:down` | stop ES — **volume stays** |
| `pnpm es:status` | ES cluster health |
| `pnpm reindex:productsv2` | copy Mongo `productsv2` into the ES index (resume: `-- --from=<last id>`) |

## Mongo mode

`MONGO_MODE` = `auto` (default), `standalone`, `replica` or `sharded`. On startup each host in `MONGO_URI` is probed and the app adapts (standalone `w:1`, replica/sharded `w:majority`). A fixed value must match what is found, else startup fails. `NODE_ENV=production` only starts with `replica` or `sharded`.

## productsv2 (Elasticsearch vs Mongo)

- `/products` is unchanged. `/productsv2` is the same API on its own Mongo collection (`productsv2`, only the `_id` index).
- `ENABLE_ES=true` serves list, search, page and cursor from Elasticsearch. `false` serves the same from Mongo. `/:id` is always Mongo.
- Each list request logs `productsv2 list via elasticsearch|mongodb` at `LOG_LEVEL=http`. Startup logs the backend once.
- Caps: `limit` max 100, `page * limit` max 10,000 (use cursor for deeper), `name` max 100 chars, ES timeout 3s. ES down (or circuit open) falls back to Mongo for that request. Every list response carries an `X-Backend` header (`elasticsearch`, `mongodb` or `mongodb-fallback`) and a log line. The fallback only has data if the Mongo the app points to has a `productsv2` collection.
- Setup: `pnpm es:up`, copy `products` into `productsv2` in Mongo, `pnpm reindex:productsv2`, set `ENABLE_ES=true`.
- Turned `ENABLE_ES` off for a while? Run `pnpm reindex:productsv2` before turning it on again, ES is not synced while off.

## Running via pm2

Two pm2 apps are defined in `ecosystem.config.json`:

| App | Mode | Instances | watch | script |
|---|---|---|---|---|
| `flipkart-dev` | fork | 1 | false (tsup `--watch` already rebuilds + restarts) | `pnpm dev` |
| `flipkart-prod` | **cluster** | **4** | false | `dist/server.js` (already built) |

`flipkart-prod` runs the already-built file directly — not `pnpm start:prod` — on purpose: in cluster mode pm2 forks 4 worker processes from the same script, so if the script itself triggered a build (like `pnpm start:prod` does), all 4 workers would race to build at once. `scripts/start-prod.sh` builds once *before* handing the built file to pm2.

```bash
./scripts/dev.sh          # pm2: start "flipkart-dev" (runs `pnpm dev`) if not running, else restart
./scripts/start-prod.sh   # pnpm build:prod, then pm2 start/reload "flipkart-prod" (4 cluster workers)
```

Both scripts are idempotent — safe to re-run any time you change code. `start-prod.sh` uses `pm2 reload` (zero-downtime rolling restart across the 4 workers) when already running, `dev.sh` uses `pm2 restart`. Logs land in `logs/{dev,prod}-{out,error}.log`.

## API docs

Swagger UI: `http://localhost:5003/api-docs` (once the server is running).

Health check: `GET /health`.

## Routes

All list endpoints use **cursor pagination**: `?cursor=<last _id from previous page>&limit=<n>`. `limit` is clamped to a maximum of **100** (default 20) regardless of what's requested.

### Products (`/products`)

| Method | Path | Body / Query |
|---|---|---|
| GET | `/` | `?cursor&limit&category&name` (`name` = text-index word search) |
| GET | `/:id` | |
| POST | `/` | `{ name, description, price, stock, category, imageUrl }` |
| PUT | `/:id` | any subset of the above |
| DELETE | `/:id` | |

### Cart (`/cart`)

| Method | Path | Body / Query | Notes |
|---|---|---|---|
| GET | `/` | `?cursor&limit` | Returns `{ items, nextCursor, total }` — `total` is the full cart value (price × qty summed across the whole cart via aggregation), not just the current page |
| GET | `/:id` | | |
| POST | `/` | `{ productId, qty }` | Adding an existing `productId` again increments its `qty` instead of duplicating the line |
| PUT | `/:id` | `{ qty }` | |
| DELETE | `/:id` | | |

### Wishlist (`/wishlist`)

| Method | Path | Body / Query |
|---|---|---|
| GET | `/` | `?cursor&limit` |
| GET | `/:id` | |
| POST | `/` | `{ productId }` — `409` if the product is already wishlisted |
| DELETE | `/:id` | |

## Seeding products

Bulk-inserts fake products directly via the MongoDB driver (bypasses Mongoose document hydration — the dominant cost at millions-of-docs scale). Non-`_id` indexes are dropped before the insert and rebuilt after, to avoid index-maintenance overhead mid-insert.

```bash
# Interactive menu (only when run in a real terminal)
pnpm seed:products

# Skip the menu — pass the count directly
pnpm seed:products -- --count=1000000

# Tune batch size / concurrency for your machine (defaults: batch 5000, concurrency = min(CPU cores, 8))
pnpm seed:products -- --count=10000000 --batch-size=10000 --concurrency=8
```

Menu options: 1M / 4M / 6M / 10M (= 1 crore, default) / custom. Piped/non-interactive runs with no `--count` default straight to 10M without prompting.

Self-check for the batch-planning logic: `node dist/seed-products.js --selfcheck` (build first with `pnpm build`).
