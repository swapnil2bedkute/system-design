// uWebSockets.js scales across cores with threads, not processes: one acceptor on the main thread owns the port and
// hands every new connection to one of the worker threads. Each worker is a full copy of the app (own cuckoo filter,
// own Mongo, Redis and ES connections), the same shape as the PM2 workers of the Fastify version.
import { Worker, isMainThread } from 'node:worker_threads';

if (isMainThread) {
  const { default: uWS } = await import('./http/uws.js');
  const { env } = await import('./bootstrap/env.js');

  const acceptor = uWS.App();
  let ready = 0;
  for (let i = 0; i < env.workers; i++) {
    const worker = new Worker(new URL(import.meta.url));
    worker.on('message', (descriptor) => {
      acceptor.addChildAppDescriptor(descriptor);
      // listen only when every worker can take connections, otherwise early requests would hit a half started app
      if (++ready === env.workers) {
        acceptor.listen(env.port, (token) => {
          if (!token) {
            console.error(`Could not listen on :${env.port}`);
            process.exit(1);
          }
          console.log(`Listening on :${env.port} with ${env.workers} worker threads`);
        });
      }
    });
    worker.on('error', (err) => {
      console.error('worker crashed:', err);
      process.exit(1);
    });
  }
} else {
  await import('./worker.js');
}
