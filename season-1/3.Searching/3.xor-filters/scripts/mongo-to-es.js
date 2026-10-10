import mongoose from 'mongoose';
import { Client } from '@elastic/elasticsearch';
import { env } from '../src/bootstrap/env.js';
import { Username } from '../src/features/usernames/usernames.model.js';

const INDEX = env.esIndex;
const BATCH = 10000;
const es = new Client({ node: process.env.ES_URL || 'http://127.0.0.1:9200' });

const fmt = (n) => n.toLocaleString('en-US');
const secs = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`);

const draw = (done, total, started) => {
  const pct = total ? Math.min(done / total, 1) : 1;
  const elapsed = (Date.now() - started) / 1000;
  const rate = elapsed > 0 ? done / elapsed : 0;
  const eta = rate > 0 ? (total - done) / rate : 0;
  const filled = Math.round(pct * 30);
  const line = `[${'█'.repeat(filled)}${'░'.repeat(30 - filled)}] ${(pct * 100).toFixed(1).padStart(5)}%  ${fmt(done)}/${fmt(total)}  ${fmt(Math.round(rate))} docs/s  elapsed ${secs(elapsed)}  ETA ${secs(eta)}`;
  if (process.stdout.isTTY) process.stdout.write(`\r${line}\x1b[K`);
  else console.log(line);
};

const flush = async (batch) => {
  const res = await es.bulk({ operations: batch.flatMap((d) => [{ index: { _index: INDEX, _id: String(d._id) } }, { username: d.username }]) });
  if (res.errors) {
    const bad = res.items.find((i) => i.index?.error);
    throw new Error(`bulk failed: ${JSON.stringify(bad.index.error)}`);
  }
};

// read-only on Mongo, so no autoIndex
mongoose.set('autoIndex', false);
await mongoose.connect(env.mongoUri, { dbName: env.dbName });

const total = await Username.estimatedDocumentCount();
console.log(`Mongo ${env.dbName}.usernames: ${fmt(total)} docs  ->  ES index "${INDEX}"`);

if (!(await es.indices.exists({ index: INDEX }))) {
  await es.indices.create({
    index: INDEX,
    settings: { number_of_shards: 1, number_of_replicas: 0 },
    mappings: { properties: { username: { type: 'keyword' } } },
  });
  console.log('Index created');
}
// no refresh while loading is the biggest speed win
await es.indices.putSettings({ index: INDEX, settings: { refresh_interval: '-1' } });

const started = Date.now();
let done = 0;
try {
  let batch = [];
  draw(0, total, started);
  for await (const doc of Username.find().select('username').lean().cursor({ batchSize: BATCH })) {
    batch.push(doc);
    if (batch.length === BATCH) {
      await flush(batch);
      done += batch.length;
      batch = [];
      draw(done, total, started);
    }
  }
  if (batch.length) {
    await flush(batch);
    done += batch.length;
  }
  draw(done, total, started);
  process.stdout.write('\n');
} finally {
  await es.indices.putSettings({ index: INDEX, settings: { refresh_interval: '1s' } });
  await es.indices.refresh({ index: INDEX });
}

const mongoCount = await Username.countDocuments();
const { count: esCount } = await es.count({ index: INDEX });
console.log(`Done in ${secs((Date.now() - started) / 1000)}. Mongo: ${fmt(mongoCount)}  ES: ${fmt(esCount)}  ${mongoCount === esCount ? 'MATCH' : 'MISMATCH'}`);

await mongoose.disconnect();
await es.close();
