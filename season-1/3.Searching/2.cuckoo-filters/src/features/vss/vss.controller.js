// "Is this username taken?" answered by a plain Redis SET (no filter, no Mongo, no Elasticsearch), to compare with the cuckoo filter.
// Every function returns { status, body }.
//
// Keys
//   VSS_BUCKETS=1 (default): one SET per namespace. The default namespace "global" is exactly `vss:usernames`.
//   VSS_BUCKETS=N (N > 1):   many small SETs `vss:usernames:<namespace>:<bucket>`, bucket = fnv1a(username) % N.
//                            Redis keeps a SET of up to 128 short names in a very compact form, so N is chosen to stay below that.
//                            N must never change once data is stored (the same name has to land in the same bucket).
// A namespace is part of the key, not of the name, so names stay short. SADD answers 1 (new) or 0 (taken) in one atomic step, which is
// what keeps a name unique inside a namespace.
import cluster from 'node:cluster';
import { pub as redis } from '../../bootstrap/redis.js';
import { cuckoo } from '../../bootstrap/cuckoo.js';
import { env } from '../../bootstrap/env.js';

export const BASE = 'vss:usernames';
export const COUNT_KEY = 'vss:meta:counts'; // bucket mode only: hash namespace -> how many names, so stats does not have to scan
const BUCKETS = env.vssBuckets;

// 32 bit FNV-1a, a fixed and simple hash. Do not swap it later, stored names would be looked up in the wrong bucket.
const fnv1a = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

export const keyFor = (username, namespace) => {
  if (BUCKETS === 1) return namespace === 'global' ? BASE : `${BASE}:${namespace}`;
  return `${BASE}:${namespace}:${fnv1a(username) % BUCKETS}`;
};

const human = (n) => {
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(2)} GB`;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
};

const infoMemory = async () => {
  const text = await redis.info('memory');
  const get = (k) => Number(text.match(new RegExp(`^${k}:(\\d+)`, 'm'))?.[1] ?? 0);
  return { used: get('used_memory'), rss: get('used_memory_rss'), peak: get('used_memory_peak'), max: get('maxmemory') };
};

// Calls fn(key) for every key Redis has, in batches (SCAN, never blocks Redis)
const forEachBatch = async (options, fn) => {
  for await (const batch of redis.scanIterator({ COUNT: 5000, ...options })) await fn(Array.isArray(batch) ? batch : [batch]);
};

export const check = async (username, namespace) => {
  const exists = !!(await redis.sIsMember(keyFor(username, namespace), username));
  return { status: 200, body: { username, namespace, exists, checkedIn: 'Redis SET', key: keyFor(username, namespace) } };
};

export const add = async (username, namespace) => {
  const key = keyFor(username, namespace);
  const added = await redis.sAdd(key, username);
  if (!added) return { status: 409, body: { username, namespace, result: 'ALREADY_EXISTS', key } };
  if (BUCKETS > 1) await redis.hIncrBy(COUNT_KEY, namespace, 1);
  return { status: 201, body: { username, namespace, result: 'ADDED', key } };
};

export const remove = async (username, namespace) => {
  const key = keyFor(username, namespace);
  const removed = await redis.sRem(key, username);
  if (!removed) return { status: 404, body: { username, namespace, result: 'NOT_FOUND', key } };
  if (BUCKETS > 1) await redis.hIncrBy(COUNT_KEY, namespace, -1);
  return { status: 200, body: { username, namespace, result: 'REMOVED', key } };
};

// Total names and total memory, to see how much a SET costs.
// redisMemory.usedBytes is the real, total memory of Redis (INFO). keyMemory.reportedByRedis is MEMORY USAGE, Redis's own estimate for
// the key(s), which runs about 40% high on one big SET. Read the real cost of a load as the difference of usedBytes before and after.
export const stats = async (namespace, exact) => {
  const info = await infoMemory();
  let totalNames;
  let setKeys = 0;
  let reportedBytes = 0;
  if (BUCKETS === 1) {
    const key = keyFor('', namespace);
    totalNames = await redis.sCard(key);
    if (totalNames) {
      setKeys = 1;
      reportedBytes = (await redis.memoryUsage(key, exact ? { SAMPLES: 0 } : undefined)) ?? 0;
    }
  } else {
    totalNames = Number((await redis.hGet(COUNT_KEY, namespace)) ?? 0);
    await forEachBatch({ MATCH: `${BASE}:${namespace}:*` }, async (keys) => {
      setKeys += keys.length;
      for (const n of await Promise.all(keys.map((k) => redis.memoryUsage(k, { SAMPLES: 0 })))) reportedBytes += n ?? 0;
    });
  }

  return {
    status: 200,
    body: {
      key: BASE,
      mode: BUCKETS === 1 ? 'one SET per namespace' : `${BUCKETS} bucket SETs per namespace`,
      namespace,
      totalNames,
      setKeys,
      redisTotalKeys: await redis.dbSize(),
      keyMemory: {
        reportedByRedis: { bytes: reportedBytes, human: human(reportedBytes), bytesPerName: totalNames ? Number((reportedBytes / totalNames).toFixed(1)) : 0 },
        note: 'MEMORY USAGE is an estimate and runs about 40% high on one big SET. For the real cost, call this before and after loading and subtract redisMemory.usedBytes.',
      },
      redisMemory: {
        usedBytes: info.used,
        usedHuman: human(info.used),
        rssBytes: info.rss,
        rssHuman: human(info.rss),
        peakBytes: info.peak,
        peakHuman: human(info.peak),
        maxmemoryBytes: info.max,
      },
    },
  };
};

// Size of the cuckoo filter, shaped like the stats above so the two can be read side by side.
export const cuckooStats = () => {
  const bytes = cuckoo.sizeBytes;
  const mem = process.memoryUsage();
  return {
    status: 200,
    body: {
      filter: 'cuckoo',
      totalNames: cuckoo.count,
      memory: { bytes, human: human(bytes), bytesPerName: cuckoo.count ? Number((bytes / cuckoo.count).toFixed(2)) : 0 },
      processMemory: { rssBytes: mem.rss, rssHuman: human(mem.rss), heapUsedBytes: mem.heapUsed, externalBytes: mem.external, externalHuman: human(mem.external) },
      filterDetails: {
        fingerprintBits: cuckoo.fpBits,
        buckets: cuckoo.buckets,
        loadFactor: Number(cuckoo.loadFactor.toFixed(3)),
        full: !!cuckoo.victim,
        expectedFalsePositiveRate: cuckoo.expectedFalsePositiveRate,
      },
      worker: { pid: process.pid, id: cluster.isWorker ? cluster.worker.id : null },
      note: 'Every worker keeps its own copy of the filter, so the total over all workers is memory.bytes times the number of workers.',
    },
  };
};
