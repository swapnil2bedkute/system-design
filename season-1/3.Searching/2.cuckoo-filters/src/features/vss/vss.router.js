import * as controller from './vss.controller.js';

const username = { type: 'string', pattern: '^[A-Za-z0-9_]{3,30}$' };
const namespace = { type: 'string', pattern: '^[a-z0-9_]{1,30}$', default: 'global' };

const vssRoutes = async (app) => {
  // Redis down or slow: say so (503), the normal error handler would call it a server bug (500)
  const run = (fn) => async (req, reply) => {
    try {
      const out = await fn(req);
      return reply.code(out.status).send(out.body);
    } catch (err) {
      return reply.code(503).send({ error: 'Redis is not available', detail: err.message });
    }
  };

  app.get(
    '/vss/usernames/check',
    { schema: { querystring: { type: 'object', required: ['username'], properties: { username, namespace } } } },
    run((req) => controller.check(req.query.username.toLowerCase(), req.query.namespace)),
  );

  app.post(
    '/vss/usernames',
    { schema: { body: { type: 'object', required: ['username'], properties: { username, namespace } } } },
    run((req) => controller.add(req.body.username.toLowerCase(), req.body.namespace ?? 'global')),
  );

  app.delete(
    '/vss/usernames',
    { schema: { querystring: { type: 'object', required: ['username'], properties: { username, namespace } } } },
    run((req) => controller.remove(req.query.username.toLowerCase(), req.query.namespace)),
  );

  app.get(
    '/vss/usernames/stats',
    { schema: { querystring: { type: 'object', properties: { namespace, exact: { type: 'boolean', default: false } } } } },
    run((req) => controller.stats(req.query.namespace, req.query.exact)),
  );

  app.get('/cuckoo/stats', async (req, reply) => {
    const out = controller.cuckooStats();
    return reply.code(out.status).send(out.body);
  });
};

export default vssRoutes;
