export const env = {
  port: Number(process.env.PORT) || 3400,
  mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017',
  dbName: 'bloom_demo', // same Mongo data as the bloom topic, so both filters run on identical usernames
  expectedItems: Number(process.env.EXPECTED_ITEMS) || 2000000,
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  vssBuckets: Number(process.env.VSS_BUCKETS) || 1, // 1 = one big SET `vss:usernames`, more = many small SETs (see features/vss), never change it once data is stored
  cuckooFile: process.env.CUCKOO_FILE || './data/cuckoo.bin', // the shared mmap file, every worker maps this one
  esUrl: process.env.ES_URL || 'http://127.0.0.1:9200',
  esIndex: process.env.ES_INDEX || 'usernames', // must match the Mongo data above, an empty index would call taken names free
};
