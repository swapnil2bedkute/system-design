import zlib from "node:zlib";
import Fastify from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import compress from "@fastify/compress";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";

import productsRouter from "./features/products/products.router.js";
import productsV2Router from "./features/productsv2/productsv2.router.js";
import cartRouter from "./features/cart/cart.router.js";
import wishlistRouter from "./features/wishlist/wishlist.router.js";
import usersRouter from "./features/users/users.router.js";
import { swaggerSpec } from "./docs/swagger.js";
import { errorHandler } from "./shared/error.js";
import { mongoGate } from "./shared/mongo-gate.js";
import { armRequestTimeout } from "./shared/timeout.js";
import { env } from "./bootstrap/env.js";
import { logger } from "./bootstrap/logger.js";
import { redisClient } from "./bootstrap/redis.js";
import { getMongoTopology } from "./bootstrap/mongo-topology.js";
import { isIngestPost } from "./features/products/products.ingest.js";

const BODY_LIMIT = 100 * 1024;

export const buildApp = async () => {
  const app = Fastify({
    logger: false,
    bodyLimit: BODY_LIMIT,
  });

  // Must be set before any plugin registers: child plugins copy the handler at register time,
  // so setting it at the end left /products, /productsv2 etc. on Fastify's default handler.
  app.setErrorHandler(errorHandler);

  // await app.register(helmet);
  await app.register(cors);

  // COMPRESSION - FIXED VERSION
  // env me COMPRESSION_LEVEL=6 rakhna .env me
  // const level = Math.min(Math.max(env.compressionLevel ?? 6, 1), 9);

  // console.log(`Compression level set to ${level} (1=fastest, 9=smallest)`);
  // await app.register(compress, {
  //   global: true,
  //   threshold: 1024, // 1KB se chhota hai toh compress mat kar
  //   encodings: ["br", "gzip", "deflate", "identity"], // zstd hata diya - Node me abhi slow hai
  //   customTypes: /^text\/|\+json$|\+text$|\+xml$|application\/json/, // sirf JSON/text ko compress kar
  //   zlibOptions: {
  //     level: level, // gzip ke liye 6 best hai
  //   },
  //   brotliOptions: {
  //     params: {
  //       [zlib.constants.BROTLI_PARAM_QUALITY]: 1, // 11 nahi, 4 rakho - 3x fast
  //     },
  //   },
  // });

  app.addHook("onRequest", armRequestTimeout);
  app.addHook("onResponse", async (req, reply) => {
    if (isIngestPost(req)) return;
    logger.http(`${req.method} ${req.url} ${reply.statusCode}`);
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/ready", async (_req, reply) => {
    const topology = getMongoTopology();
    return reply.code(topology.reads ? 200 : 503).send({
      status: topology.reads ? "ready" : "not_ready",
      mongo: topology.connected ? "connected" : "disconnected",
      membersUp: `${topology.membersUp}/${topology.membersTotal}`,
      primary: topology.primaryHost,
      writes: topology.writes,
      reads: topology.reads,
      electionPossible: topology.electionPossible,
      redis: redisClient.isReady ? "up" : "down",
    });
  });

  await app.register(swagger, {
    mode: "static",
    specification: {
      document: swaggerSpec as never,
    },
  });
  await app.register(swaggerUi, { routePrefix: "/api-docs" });

  await app.register(async (api) => {
    api.addHook("onRequest", mongoGate);
    await api.register(usersRouter, { prefix: "/users" });
    await api.register(productsRouter, { prefix: "/products" });
    await api.register(productsV2Router, { prefix: "/productsv2" });
    await api.register(cartRouter, { prefix: "/cart" });
    await api.register(wishlistRouter, { prefix: "/wishlist" });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: `Route ${req.method} ${req.url} not found` });
  });

  return app;
};

const app = await buildApp();
export default app;
