import { parentPort, threadId } from 'node:worker_threads';
import { bootstrap } from './bootstrap/index.js';
import { startFilterReader, startEsWorker } from './features/usernames/usernames.sync.js';
import { buildApp } from './http/app.js';

const { startId } = await bootstrap();
const app = buildApp();
parentPort.postMessage(app.getDescriptor()); // tells the acceptor on the main thread: this app can take connections
startFilterReader(startId); // keeps this worker's filter in sync with the other workers
startEsWorker(); // pushes changes to Elasticsearch, retries while ES is down
console.log(`worker thread ${threadId} ready`);
