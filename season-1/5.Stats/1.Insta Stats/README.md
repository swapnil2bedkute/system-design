# Flipkart API

Modular ecommerce backend. Products. TypeScript, Fastify, Mongoose, cursor pagination, pm2, Swagger.

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
│   └── products/            # model / types / validation / controller / router
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
| `MONGO_URI` | replica URI, DB `instagram` | `replicaSet=fk-rs&w=majority&readPreference=primaryPreferred` |
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

Replica set: `fk-rs`. App DB: `instagram`. Test DB: `fk-test` (same cluster). Write concern: `w: majority`. Read: `primaryPreferred` (PRIMARY nahi to last SECONDARY se read).

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
| `pnpm consumers` | runs the Kafka consumers (likes, follows, views) in their own process. Keep it running next to the server, the API does not consume |
| `pnpm boost -- --post=<id> --likes=N --views=N --unique=N --comments=N --yes` / `--profile=<u> --followers=N --yes` | fake traffic through Kafka, 50k events per send. Without `--yes` it only prints the plan |
| `pnpm seed:insta` | builds + seeds 3 demo profiles with posts, reels and comments (insert-only, skips a profile that already has posts) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm mongo:up` | start replica set (`infra/mongo/compose.yaml`) |
| `pnpm mongo:down` | stop containers — **volumes stay** |
| `pnpm mongo:status` | compact replica roles (PRIMARY / SECONDARY / DOWN) |
| `pnpm mongo:reset` | wipe volumes + start fresh — **only this deletes data** |
| `pnpm kafka:up` | start Kafka (`infra/kafka/compose.yaml`, `localhost:9092`, volume `insta-kafka-data`) |
| `pnpm kafka:stop` | stop the container, keep it and the data |
| `pnpm kafka:down` | remove the container — **volume stays** |
| `pnpm kafka:status` | show the container state |
| `pnpm kafka:logs` | follow the last 100 log lines (Ctrl+C to leave) |
| `pnpm kafka:reset` | wipe the volume + start fresh — **deletes all Kafka data** |

## Mongo mode

`MONGO_MODE` = `auto` (default), `standalone`, `replica` or `sharded`. On startup each host in `MONGO_URI` is probed and the app adapts (standalone `w:1`, replica/sharded `w:majority`). A fixed value must match what is found, else startup fails. `NODE_ENV=production` only starts with `replica` or `sharded`.

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

### Instagram

Pages: `/` (pick a user, this is the "login") and `/u/:username` (profile). One file, `public/index.html`, Tailwind from the CDN. Logout goes back to `/`. The picked user is sent as the `x-user-id` header.

| Method | Path | Notes |
|---|---|---|
| GET | `/profiles` | all profile cards |
| GET | `/profiles/:username` | profile card, `postsCount`, `followers`, `following` (Redis counters), `isFollowing` (needs `x-user-id`) |
| POST | `/profiles/:username/follow` | header `x-user-id`. Kafka topic `follows`, answers `202`. Consumer writes Mongo `follows`, Redis `profile:{u}:followers` and `:following`, and the Cuckoo filter `user:{id}:following` |
| DELETE | `/profiles/:username/follow` | same flow, unfollow |
| GET | `/posts` | `?authorId&type=post\|reel&cursor&limit`, newest first. Every item also has `likes`, `comments`, `totalViews`, `uniqueViews` (Redis) and `isLiked`, `isSeen` (need `x-user-id`) |
| GET | `/posts/:id` | one post or reel |
| GET | `/posts/:id/comments` | `?cursor&limit`, newest first |
| GET | `/reels` | `?authorId&cursor&limit`, reels only |
| POST | `/posts/:id/view` | header `x-user-id`. Call it when a post is opened. Kafka topic `views`, answers `202`. Consumer adds 1 to `post:{id}:views` and the user to the HyperLogLog `post:{id}:uv`, and to the Cuckoo filter `user:{id}:seen` |
| POST | `/posts/:id/like` | header `x-user-id`. Goes to Kafka topic `likes`, answers `202`. A consumer writes Mongo `likes`, then Redis `post:{id}:likes` and the user's Cuckoo filter |
| DELETE | `/posts/:id/like` | same flow, removes the like |

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
