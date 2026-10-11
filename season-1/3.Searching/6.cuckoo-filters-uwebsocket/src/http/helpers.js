// Small helpers on top of uWebSockets.js. Two rules of uWS shape all of this:
//  1. `req` is only valid until the handler returns (or its first await), so read what you need from it first.
//  2. A response may only be written if the client is still there (onAborted), and writes after an await must be corked.
import { Buffer } from 'node:buffer';

export const JSON_TYPE = 'application/json; charset=utf-8';

const STATUS = {
  200: '200 OK',
  201: '201 Created',
  400: '400 Bad Request',
  404: '404 Not Found',
  409: '409 Conflict',
  500: '500 Internal Server Error',
  503: '503 Service Unavailable',
};

// body: a ready-made JSON string, or an object
const text = (body) => (typeof body === 'string' ? body : JSON.stringify(body));

// For a handler that answers before returning: it already runs inside uWS's cork, so no cork needed.
export const sendNow = (res, status, body) => {
  res.writeStatus(STATUS[status]).writeHeader('Content-Type', JSON_TYPE).end(text(body));
};

// For answers after an await: cork batches the writes into one syscall.
export const send = (res, status, body) => {
  res.cork(() => sendNow(res, status, body));
};

// Runs `work()` (async, returns { status, body }) and writes the answer unless the client left. Call it inside the handler.
export const handleAsync = (res, work) => {
  let aborted = false;
  res.onAborted(() => {
    aborted = true;
  });
  work().then(
    (out) => {
      if (!aborted) send(res, out.status, out.body);
    },
    (err) => {
      console.error(err);
      if (!aborted) send(res, 500, { error: err.message });
    },
  );
};

// Reads the request body. Call it synchronously inside the handler (the data callback must be set before the first await).
// Resolves with a Buffer, or null if the body is bigger than `limit`.
export const readBody = (res, limit = 4096) =>
  new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    res.onData((chunk, isLast) => {
      size += chunk.byteLength;
      if (size <= limit) chunks.push(Buffer.from(chunk.slice(0))); // slice(0) copies: uWS reuses that memory after this callback
      if (isLast) resolve(size > limit ? null : Buffer.concat(chunks));
    });
  });

// ^[A-Za-z0-9_]{3,30}$ without the regexp engine (this runs on every request)
export const validName = (s) => {
  if (s.length < 3 || s.length > 30) return false;
  for (let i = 0; i < s.length; i++) {
    const b = s.charCodeAt(i);
    if (!((b >= 97 && b <= 122) || (b >= 65 && b <= 90) || (b >= 48 && b <= 57) || b === 95)) return false;
  }
  return true;
};

// toLowerCase for an already validated name, no allocation when it is already lower case
export const lowerASCII = (s) => {
  for (let i = 0; i < s.length; i++) {
    const b = s.charCodeAt(i);
    if (b >= 65 && b <= 90) return s.toLowerCase();
  }
  return s;
};

// Optional integer query parameter. Returns { value } or { error } (same wording as the Fastify version used).
export const intParam = (raw, name, def, min, max) => {
  if (raw === undefined) return { value: def };
  if (!/^-?\d+$/.test(raw)) return { error: `querystring/${name} must be integer` };
  const value = Number(raw);
  if (value < min) return { error: `querystring/${name} must be >= ${min}` };
  if (value > max) return { error: `querystring/${name} must be <= ${max}` };
  return { value };
};

// Prebuilt 400 bodies for the hot validation errors
export const ERR = {
  usernameRequired: JSON.stringify({ error: "querystring must have required property 'username'" }),
  usernamePattern: JSON.stringify({ error: 'querystring/username must match pattern "^[A-Za-z0-9_]{3,30}$"' }),
  consistency: JSON.stringify({ error: 'querystring/consistency must be equal to one of the allowed values' }),
  bodyJson: JSON.stringify({ error: 'body is not valid JSON' }),
  bodyTooBig: JSON.stringify({ error: 'body is too large' }),
  bodyRequired: JSON.stringify({ error: "body must have required property 'username'" }),
  bodyPattern: JSON.stringify({ error: 'body/username must match pattern "^[A-Za-z0-9_]{3,30}$"' }),
  notFound: JSON.stringify({ error: 'Route not found' }),
};
