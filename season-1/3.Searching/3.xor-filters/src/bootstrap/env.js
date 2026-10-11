export const env = {
  port: Number(process.env.PORT) || 3600,
  mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017',
  dbName: 'bloom_demo', // same Mongo data as the bloom and cuckoo topics, so all filters run on identical usernames
  deltaLimit: Number(process.env.DELTA_LIMIT) || 50000, // names added after a build live in a small Set, past this many the filter is rebuilt
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  esUrl: process.env.ES_URL || 'http://127.0.0.1:9200',
  esIndex: process.env.ES_INDEX || 'usernames', // must match the Mongo data above, an empty index would call taken names free
};
