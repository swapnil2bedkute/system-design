import { spawn } from "node:child_process";
import path from "node:path";
import * as p from "@clack/prompts";
import { listServers, readServerPort } from "../src/measure.js";

const v2Dir = path.resolve(import.meta.dirname);

const TEST_LABELS = {
  "01-normal-load-100-users-2min.js": "0-100 Users for 2 Min",
  "02-stress-600-users-3min.js": "0-600 Users for 3 Min",
  "03-breakpoint-1000-users-1min.js": "0-1,000 Users for 1 Min",
  "04-breakpoint-3000-users-2min.js": "0-3,000 Users for 2 Min",
  "05-breakpoint-5000-users-1min.js": "0-5,000 Users for 1 Min",
  "06-breakpoint-10000-users-2min.js": "0-10,000 Users for 2 Min",
  "07-breakpoint-10000-users-fast-25s.js": "0-10,000 Users for 25 Sec",
  "08-breakpoint-9000-users-2min.js": "0-9,000 Users for 2 Min",
  "09-breakpoint-20000-users-2min.js": "0-20,000 Users for 2 Min",
  "10-breakpoint-40000-users-2min.js": "0-40,000 Users for 2 Min",
  "11-breakpoint-50000-users-2min.js": "0-50,000 Users for 2 Min",
  "12-breakpoint-100000-users-2min.js": "0-100,000 Users for 2 Min",
  "13-breakpoint-150000-users-2min.js": "0-150,000 Users for 2 Min",
  "14-breakpoint-200000-users-2min.js": "0-200,000 Users for 2 Min",
  "15-breakpoint-500000-users-2min.js": "0-500,000 Users for 2 Min",
  "16-breakpoint-1000000-users-2min.js": "0-1,000,000 Users for 2 Min",
};

const ALLOWED_SERVERS = {
  "01-node": "NodeJS Bare",
  "02-express": "Express.js",
  "03-fastify": "Fastify",
  "05-go": "Go",
};

// ponytail: hardcoded, mirrors servers/nginx/nginx.conf (listen 8080, one path
// prefix per backend). Update here if that file changes.
const NGINX_PORT = 8080;
const NGINX_PREFIX = {
  "01-node": "/node",
  "02-express": "/express",
  "03-fastify": "/fastify",
  "05-go": "/go",
};

const DEFAULT_API = "/products?limit=10";

// ponytail: the search combo exists in the seed data (Premium + Electronics). Change it here if the seed changes.
const FASTIFY_APIS = [
  { value: DEFAULT_API, label: "/products list (Mongo, text + category index)" },
  { value: "/productsv2?limit=10", label: "/productsv2 list (ES or Mongo, follows ENABLE_ES)" },
  {
    value: "/productsv2?name=Premium&category=Electronics&limit=10",
    label: "/productsv2 search, name + category (ES or Mongo, follows ENABLE_ES)",
  },
];

const stopIfCancel = (value) => {
  if (p.isCancel(value)) {
    p.cancel("Stopped.");
    process.exit(0);
  }
  return value;
};

// bust=true adds a unique query: nginx caches 200s for 15s, so a plain probe
// could still look "live" right after the backend behind it was stopped.
const isLive = async (base, bust = false) => {
  for (const route of ["/health", "/products?page=1&limit=1"]) {
    const sep = route.includes("?") ? "&" : "?";
    const url = `${base}${route}${bust ? `${sep}_=${Date.now()}` : ""}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(800) });
      if (res.ok) return true;
    } catch {
      // not reachable on this path, try the next
    }
  }
  return false;
};

p.intro("Bench v2 picker");

const file = stopIfCancel(
  await p.select({
    message: "Which test?",
    options: Object.entries(TEST_LABELS).map(([name, label]) => ({
      value: name,
      label,
    })),
  }),
);

const servers = (await listServers()).filter(
  (server) => ALLOWED_SERVERS[server.name],
);
const withStatus = (
  await Promise.all(
    servers.map(async (server) => {
      const label = ALLOWED_SERVERS[server.name];
      const nginxBase = `http://127.0.0.1:${NGINX_PORT}${NGINX_PREFIX[server.name]}`;
      let directBase = null;
      try {
        directBase = `http://127.0.0.1:${await readServerPort(server.dir)}`;
      } catch {
        // no PORT configured, the direct option stays off
      }
      const [directLive, nginxLive] = await Promise.all([
        directBase ? isLive(directBase) : false,
        isLive(nginxBase, true),
      ]);
      return [
        { value: server.name, label, base: directBase, live: directLive },
        {
          value: `${server.name}-nginx`,
          label: `${label} (Nginx)`,
          base: nginxBase,
          live: nginxLive,
          nginx: true,
        },
      ];
    }),
  )
).flat();
const live = withStatus.filter((option) => option.live);

if (live.length === 0) {
  p.outro(
    "No server is running. Start one (pnpm dev in its folder) and try again.",
  );
  process.exit(0);
}

const chosenValue = stopIfCancel(
  await p.select({
    message: "Which server?",
    options: live.map((option) => ({
      value: option.value,
      label: option.label,
    })),
  }),
);
const chosen = live.find((option) => option.value === chosenValue);

// Only nginx compresses here, so only nginx gets the question. Normal sends
// "identity", otherwise k6 would send gzip, br, zstd on its own.
const encoding = chosen.nginx
  ? stopIfCancel(
      await p.select({
        message: "Compression?",
        options: [
          { value: "identity", label: "Normal" },
          { value: "gzip", label: "Gzip" },
          { value: "br", label: "Brotli" },
        ],
      }),
    )
  : null;

// Only 03-fastify has /productsv2. Every other server keeps the plain list.
const apiPath = chosen.value.startsWith("03-fastify")
  ? stopIfCancel(
      await p.select({
        message: "Which API?",
        options: FASTIFY_APIS,
      }),
    )
  : DEFAULT_API;

const url = `${chosen.base}${apiPath}`;
p.note(
  `${chosen.label}${encoding ? ` | ${encoding}` : ""}\n${url}${
    apiPath.startsWith("/productsv2")
      ? "\nBackend follows ENABLE_ES in that server's .env. Use LOG_LEVEL=info for a clean run."
      : ""
  }`,
  "Running",
);

const k6Env = ["-e", `URL=${url}`];
if (encoding) k6Env.push("-e", `ENCODING=${encoding}`);

const child = spawn("k6", ["run", ...k6Env, path.join(v2Dir, file)], {
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));
