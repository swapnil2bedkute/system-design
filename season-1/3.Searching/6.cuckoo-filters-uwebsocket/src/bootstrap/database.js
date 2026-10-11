import mongoose from 'mongoose';
import { env } from './env.js';

export const connectDatabase = async () => {
  await mongoose.connect(env.mongoUri, { dbName: env.dbName });
  console.log(`Mongo connected: ${env.dbName}`);
};
