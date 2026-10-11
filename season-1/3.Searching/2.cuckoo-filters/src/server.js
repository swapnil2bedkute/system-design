import { env } from './bootstrap/env.js';
import { bootstrap } from './bootstrap/index.js';
import { startFilterReader, startEsWorker } from './features/usernames/usernames.sync.js';
import { buildApp } from './app.js';

const { startId } = await bootstrap();
const app = await buildApp();
await app.listen({ port: env.port, host: '0.0.0.0' });
startFilterReader(startId); // keeps this worker's filter in sync with the other workers
startEsWorker(); // pushes changes to Elasticsearch, retries while ES is down
console.log(`Listening on :${env.port}`);
