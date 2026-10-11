// HTTP layer smoke test. No Mongo, no Redis, no Elasticsearch: it only uses answers the cuckoo filter gives by itself.
// Run with a Node version that has a uWebSockets.js binary (22 or 24, see .nvmrc).
import assert from 'node:assert';
import uWS from '../src/http/uws.js';
import { buildApp } from '../src/http/app.js';

const PORT = 39000 + Math.floor(Math.random() * 900);
const base = `http://127.0.0.1:${PORT}`;
const app = buildApp();
const token = await new Promise((resolve) => app.listen(PORT, resolve));
assert(token, 'could not listen');

const call = async (path, init) => {
  const r = await fetch(base + path, init);
  return { status: r.status, type: r.headers.get('content-type'), text: await r.text() };
};

// a new name: the empty filter is sure, so the answer comes straight back, exact text
let r = await call('/check-username?username=Brand_New1');
assert.equal(r.status, 200);
assert.equal(r.type, 'application/json; charset=utf-8');
assert.deepEqual(JSON.parse(r.text), {
  username: 'brand_new1',
  result: 'AVAILABLE',
  cuckooFilter: 'Not present',
  checkedIn: 'Not needed',
  reason: 'Cuckoo filter is sure this username was never added, so no database lookup was needed.',
});
assert.equal(Object.keys(JSON.parse(r.text)).join(), 'username,result,cuckooFilter,checkedIn,reason'); // same field order as before

// bad input is a 400 with a message
for (const [path, msg] of [
  ['/check-username', "querystring must have required property 'username'"],
  ['/check-username?username=ab', 'querystring/username must match pattern "^[A-Za-z0-9_]{3,30}$"'],
  ['/check-username?username=a%20b', 'querystring/username must match pattern "^[A-Za-z0-9_]{3,30}$"'],
  ['/check-username?username=abcd&consistency=xyz', 'querystring/consistency must be equal to one of the allowed values'],
  ['/fp-test?n=0', 'querystring/n must be >= 1'],
  ['/fp-test?n=abc', 'querystring/n must be integer'],
  ['/fp-test?n=2000000', 'querystring/n must be <= 1000000'],
  ['/ingest?count=0', 'querystring/count must be >= 1'],
  ['/check-username-in-db', "querystring must have required property 'username'"],
]) {
  r = await call(path, path.startsWith('/ingest') ? { method: 'POST' } : undefined);
  assert.equal(r.status, 400, `${path} should be 400, got ${r.status}`);
  assert.equal(JSON.parse(r.text).error, msg, path);
}
r = await call('/delete-username?username=ab', { method: 'DELETE' });
assert.equal(r.status, 400);

// POST body checks (all rejected before any database call)
const post = (body) => call('/add-username', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
assert.equal((await post('{nope')).status, 400);
assert.equal(JSON.parse((await post('{nope')).text).error, 'body is not valid JSON');
assert.equal(JSON.parse((await post('{}')).text).error, "body must have required property 'username'");
assert.equal(JSON.parse((await post('{"username":"x"}')).text).error, 'body/username must match pattern "^[A-Za-z0-9_]{3,30}$"');
assert.equal(JSON.parse((await post('{"username":42}')).text).error, 'body/username must match pattern "^[A-Za-z0-9_]{3,30}$"');
assert.equal((await post(JSON.stringify({ username: 'a'.repeat(5000) }))).status, 400); // bigger than the 4 KB body limit

// stats, fp-test, unknown route
r = await call('/stats');
assert.equal(r.status, 200);
const s = JSON.parse(r.text);
assert(s.cuckoo && s.checks.answeredByCuckoo >= 1, 'stats should show the filter and the counted check');
r = await call('/fp-test?n=1000');
assert.equal(JSON.parse(r.text).tested, 1000);
r = await call('/nope');
assert.equal(r.status, 404);

// many requests in a row on one connection keep working (keep-alive)
for (let i = 0; i < 2000; i++) {
  const x = await fetch(`${base}/check-username?username=name_${i}`);
  assert.equal(x.status, 200);
  await x.arrayBuffer();
}

uWS.us_listen_socket_close(token);
console.log('ok');
process.exit(0);
