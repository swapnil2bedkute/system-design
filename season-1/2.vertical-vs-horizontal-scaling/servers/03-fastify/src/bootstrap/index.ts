import "./mongo-host-dns.js";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { connectDatabase } from "./database.js";
import { connectRedis } from "./redis.js";
import { ensureEsIndex } from "./elastic.js";
import { registerProcessHandlers } from "./shutdown.js";

export const bootstrap = async () => {
  registerProcessHandlers();
  await connectDatabase();
  void connectRedis();
  logger.info(`productsv2 list backend: ${env.enableEs ? "elasticsearch" : "mongodb"}`);
  if (env.enableEs) {
    // ES down at startup must not block the app. Requests get 503 until it is back.
    await ensureEsIndex().catch((err: unknown) =>
      logger.warn(`Elasticsearch not ready: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
  logger.info(`Bootstrap complete — env: ${env.nodeEnv}`);
  return { logger, env };
};
