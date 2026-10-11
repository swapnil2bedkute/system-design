import * as controller from './usernames.controller.js';

const usernameSchema = { type: 'string', pattern: '^[A-Za-z0-9_]{3,30}$' };

const usernamesRoutes = async (app) => {
  app.post('/add-username', {
    schema: { body: { type: 'object', required: ['username'], properties: { username: usernameSchema } } },
  }, controller.addUsername);

  app.get('/check-username', {
    schema: { querystring: { type: 'object', required: ['username'], properties: { username: usernameSchema, consistency: { type: 'string', enum: ['strong', 'eventual'], default: 'eventual' } } } },
  }, controller.checkUsername);

  // ponytail: waits for the whole ingest, fine up to ~10 lakh. Bigger needs a background job.
  app.post('/ingest', {
    schema: { querystring: { type: 'object', properties: { count: { type: 'integer', minimum: 1, maximum: 1000000, default: 20000 } } } },
  }, controller.ingest);

  app.get('/stats', controller.stats);

  app.get('/fp-test', {
    schema: { querystring: { type: 'object', properties: { n: { type: 'integer', minimum: 1, maximum: 1000000, default: 10000 } } } },
  }, controller.fp);
};

export default usernamesRoutes;
