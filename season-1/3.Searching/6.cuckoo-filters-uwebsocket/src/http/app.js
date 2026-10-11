import uWS from './uws.js';
import * as controller from '../features/usernames/usernames.controller.js';
import { sendNow, handleAsync, readBody, validName, lowerASCII, intParam, ERR } from './helpers.js';

// Reads and checks ?username= . Returns the lower-cased name, or null after it has already answered with a 400.
const usernameFromQuery = (res, req) => {
  const raw = req.getQuery('username');
  if (raw === undefined) return void sendNow(res, 400, ERR.usernameRequired);
  if (!validName(raw)) return void sendNow(res, 400, ERR.usernamePattern);
  return lowerASCII(raw);
};

// Reads an optional integer ?name= . Returns the number, or null after it has already answered with a 400.
const intFromQuery = (res, req, name, def, min, max) => {
  const r = intParam(req.getQuery(name), name, def, min, max);
  if (r.error) return void sendNow(res, 400, { error: r.error });
  return r.value;
};

export const buildApp = () => {
  const app = uWS.App();

  app.get('/check-username', (res, req) => {
    const username = usernameFromQuery(res, req);
    if (username === undefined) return;
    const consistency = req.getQuery('consistency') ?? 'eventual';
    if (consistency !== 'strong' && consistency !== 'eventual') return sendNow(res, 400, ERR.consistency);

    const fast = controller.checkFast(username); // the filter says no: answered right here, nothing async
    if (fast !== null) return sendNow(res, 200, fast);
    handleAsync(res, () => controller.checkSlow(username, consistency === 'strong'));
  });

  // straight to Mongo every time: no filter, no Elasticsearch
  app.get('/check-username-in-db', (res, req) => {
    const username = usernameFromQuery(res, req);
    if (username === undefined) return;
    handleAsync(res, () => controller.checkUsernameInDb(username));
  });

  app.post('/add-username', (res) => {
    const bodyPromise = readBody(res); // must be started inside the handler, before any await
    handleAsync(res, async () => {
      const raw = await bodyPromise;
      if (raw === null) return { status: 400, body: ERR.bodyTooBig };
      let data;
      try {
        data = JSON.parse(raw.toString('utf8'));
      } catch {
        return { status: 400, body: ERR.bodyJson };
      }
      const name = data && typeof data === 'object' ? data.username : undefined;
      if (name === undefined) return { status: 400, body: ERR.bodyRequired };
      if (typeof name !== 'string' || !validName(name)) return { status: 400, body: ERR.bodyPattern };
      return controller.addUsername(lowerASCII(name));
    });
  });

  app.del('/delete-username', (res, req) => {
    const username = usernameFromQuery(res, req);
    if (username === undefined) return;
    handleAsync(res, () => controller.deleteUsername(username));
  });

  // ponytail: waits for the whole ingest, fine up to ~10 lakh. Bigger needs a background job.
  app.post('/ingest', (res, req) => {
    const count = intFromQuery(res, req, 'count', 20000, 1, 1000000);
    if (count === undefined) return;
    handleAsync(res, () => controller.ingest(count));
  });

  app.get('/stats', (res) => {
    const out = controller.stats();
    sendNow(res, out.status, out.body);
  });

  app.get('/fp-test', (res, req) => {
    const n = intFromQuery(res, req, 'n', 10000, 1, 1000000);
    if (n === undefined) return;
    const out = controller.fp(n);
    sendNow(res, out.status, out.body);
  });

  app.any('/*', (res) => sendNow(res, 404, ERR.notFound));

  return app;
};
