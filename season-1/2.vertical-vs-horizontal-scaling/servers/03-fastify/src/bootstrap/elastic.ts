import { Client } from "@elastic/elasticsearch";
import { env } from "./env.js";
import { logger } from "./logger.js";

// ponytail: fixed caps, not env vars. Make them env only if they ever need tuning per deploy.
const REQUEST_TIMEOUT_MS = 3000;
const MAX_CONNECTIONS = 20;

// One client per process, created on first use. With ENABLE_ES=false nothing ever calls this.
let client: Client | null = null;

export const esClient = (): Client => {
  client ??= new Client({
    node: env.esUrl,
    requestTimeout: REQUEST_TIMEOUT_MS,
    // no client retry: a retry doubles latency and load on a sick ES. The breaker below decides instead.
    maxRetries: 0,
    // undici agent: caps open connections to ES per worker
    agent: { connections: MAX_CONNECTIONS },
  });
  return client;
};

// dynamic strict: a typo in a field name fails loudly instead of silently adding a field
const mappings = {
  dynamic: "strict",
  properties: {
    mongoId: { type: "keyword" },
    name: { type: "text" },
    category: { type: "keyword" },
    price: { type: "float" },
    imageUrl: { type: "keyword", index: false, doc_values: false },
  },
} as const;

const settings = {
  number_of_shards: 1,
  number_of_replicas: 0,
  refresh_interval: "5s",
  max_result_window: 10_000,
};

// Every worker calls this at startup and they race. "already exists" is the normal loser case.
export const ensureEsIndex = async (): Promise<void> => {
  const es = esClient();
  if (await es.indices.exists({ index: env.esIndex })) return;

  try {
    await es.indices.create({ index: env.esIndex, settings, mappings });
    logger.info(`Elasticsearch index created: ${env.esIndex}`);
  } catch (err) {
    const type = (err as { body?: { error?: { type?: string } } }).body?.error?.type;
    if (type !== "resource_already_exists_exception") throw err;
  }
};

// ---- circuit breaker: one place for every ES call on the request path ----
// closed -> N infra failures in a row -> open (instant 503 for OPEN_MS, ES is not touched at all)
// -> half-open (exactly ONE probe request goes through, the rest still get the instant 503)
// -> probe ok = closed, probe fails = open again. State is per worker (cluster), no shared store.
const FAIL_THRESHOLD = 3;
const OPEN_MS = 5000;

let fails = 0;
let openUntil = 0;
let probing = false;

export class EsUnavailableError extends Error {
  readonly status = 503;
  constructor(readonly retryAfter: number) {
    super("Search is temporarily unavailable");
  }
}

// Only infra problems trip the breaker. A 400 from a bad query is the caller's bug, not ES being down.
const isInfraFailure = (err: unknown): boolean => {
  const e = err as { name?: string; statusCode?: number };
  if (e.name === "ConnectionError" || e.name === "TimeoutError" || e.name === "NoLivingConnectionsError") return true;
  return e.statusCode === 429 || (e.statusCode !== undefined && e.statusCode >= 502 && e.statusCode <= 504);
};

const retryAfterSeconds = (): number => Math.max(1, Math.ceil((openUntil - Date.now()) / 1000));

export const withEs = async <T>(fn: () => Promise<T>): Promise<T> => {
  const now = Date.now();
  const open = fails >= FAIL_THRESHOLD;

  if (open) {
    // still cooling down, or a probe is already in flight: fail instantly
    if (now < openUntil || probing) throw new EsUnavailableError(retryAfterSeconds());
    probing = true; // half-open: this request is the probe
  }

  try {
    const result = await fn();
    if (open) logger.info("Elasticsearch circuit CLOSED (probe ok)");
    fails = 0;
    return result;
  } catch (err) {
    if (!isInfraFailure(err)) {
      if (open) fails = 0; // ES answered (just not happily), so it is reachable
      throw err;
    }
    logger.error(`Elasticsearch call failed: ${err instanceof Error ? err.message : String(err)}`);
    fails += 1;
    if (fails >= FAIL_THRESHOLD) {
      openUntil = Date.now() + OPEN_MS;
      logger.warn(`Elasticsearch circuit OPEN for ${OPEN_MS / 1000}s`);
    }
    // callers only ever see one error type for "ES is down"
    throw new EsUnavailableError(fails >= FAIL_THRESHOLD ? retryAfterSeconds() : 1);
  } finally {
    if (open) probing = false;
  }
};

export const closeElastic = async (): Promise<void> => {
  if (!client) return;
  await client.close();
  client = null;
};
