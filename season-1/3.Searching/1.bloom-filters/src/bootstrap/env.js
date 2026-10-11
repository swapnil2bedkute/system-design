export const env = {
  port: Number(process.env.PORT) || 3300,
  mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017',
  dbName: 'bloom_demo',
  expectedItems: Number(process.env.EXPECTED_ITEMS) || 3300000, // 30 lakh names plus ~10% room, a full filter's false positive rate shoots up
  falsePositiveRate: Number(process.env.FP_RATE) || 0.0001, // 0.01%, about 19 bits per name
  esUrl: process.env.ES_URL || 'http://127.0.0.1:9200',
  esIndex: process.env.ES_INDEX || 'usernames',
};
