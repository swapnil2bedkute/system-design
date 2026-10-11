import "../bootstrap/mongo-host-dns.js";
import mongoose from "mongoose";
import { connectDatabase, disconnectDatabase } from "../bootstrap/database.js";
import { closeElastic, ensureEsIndex, esClient } from "../bootstrap/elastic.js";
import { env } from "../bootstrap/env.js";
import { logger } from "../bootstrap/logger.js";
import { bulkIndex } from "../features/productsv2/productsv2.search.js";

// Copies Mongo productsv2 into the ES index, in _id order. Safe to re-run (ES doc _id = Mongo _id).
// Resume after a stop: pnpm reindex:productsv2 -- --from=<last id from the progress log>
// ponytail: mongodb is not a direct dependency, mongoose re-exports its driver
const { ObjectId } = mongoose.mongo;
type ObjectId = InstanceType<typeof ObjectId>;

const BATCH = 5000;
const RETRY_MS = [1000, 2000, 5000, 10_000, 20_000];
const PROGRESS_EVERY = 20;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const fromFlag = (): ObjectId | null => {
  const flag = process.argv.find((a) => a.startsWith("--from="));
  if (!flag) return null;
  const value = flag.split("=")[1] ?? "";
  if (!ObjectId.isValid(value)) throw new Error(`Invalid --from value: ${value}`);
  return new ObjectId(value);
};

// ES answers 429 when it is busy. Back off and retry the same batch instead of pushing harder.
const bulkWithBackoff = async (docs: Parameters<typeof bulkIndex>[0]): Promise<number> => {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await bulkIndex(docs)).failed;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      const wait = RETRY_MS[attempt];
      if (status !== 429 || wait === undefined) throw err;
      logger.warn(`ES busy (429), retry in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
};

const main = async (): Promise<void> => {
  await connectDatabase();
  await ensureEsIndex();

  const es = esClient();
  const collection = mongoose.connection.collection("productsv2");
  let last = fromFlag();
  let indexed = 0;
  let failed = 0;
  let batches = 0;
  const startedAt = Date.now();

  // no refresh while bulk loading is much faster. Restored below, even on error.
  await es.indices.putSettings({ index: env.esIndex, settings: { refresh_interval: "-1" } });
  try {
    for (;;) {
      const docs = await collection
        .find(last ? { _id: { $gt: last } } : {})
        .sort({ _id: 1 })
        .limit(BATCH)
        .toArray();
      if (docs.length === 0) break;

      failed += await bulkWithBackoff(docs as never);
      indexed += docs.length;
      last = docs[docs.length - 1]?._id as ObjectId;
      batches += 1;

      if (batches % PROGRESS_EVERY === 0) {
        const sec = (Date.now() - startedAt) / 1000;
        logger.info(`Reindexed ${indexed} | failed ${failed} | ${Math.round(indexed / sec)} docs/sec | last id ${String(last)}`);
      }
    }
  } finally {
    await es.indices.putSettings({ index: env.esIndex, settings: { refresh_interval: "5s" } });
    await es.indices.refresh({ index: env.esIndex });
  }

  const count = await es.count({ index: env.esIndex });
  logger.info(`Done. Reindexed ${indexed} | failed ${failed} | ES count ${count.count} | last id ${String(last)}`);

  await closeElastic();
  await disconnectDatabase();
  process.exit(failed > 0 ? 1 : 0);
};

main().catch((err: unknown) => {
  logger.error(`Reindex failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
