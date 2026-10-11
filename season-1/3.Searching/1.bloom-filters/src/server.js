import { env } from './bootstrap/env.js';
import { bootstrap } from './bootstrap/index.js';
import { buildApp } from './app.js';

await bootstrap();
const app = await buildApp();
await app.listen({ port: env.port, host: '0.0.0.0' });
console.log(`Listening on :${env.port}`);
