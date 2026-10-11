import Fastify from 'fastify';
import usernamesRouter from './features/usernames/usernames.router.js';
import { errorHandler } from './shared/error.js';

export const buildApp = async () => {
  const app = Fastify({ logger: false });
  app.setErrorHandler(errorHandler);
  await app.register(usernamesRouter);
  return app;
};
