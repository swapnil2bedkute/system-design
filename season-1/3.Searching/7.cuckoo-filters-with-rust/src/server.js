import { env } from './bootstrap/env.js';
import { bootstrap } from './bootstrap/index.js';
import { startEsWorker } from './features/usernames/usernames.sync.js';
import { buildApp } from './app.js';

await bootstrap();
const app = await buildApp();
await app.listen({ port: env.port, host: '0.0.0.0' });
startEsWorker(); // pushes changes to Elasticsearch, retries while ES is down
console.log(`Listening on :${env.port}`);
