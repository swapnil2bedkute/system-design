import type { FastifyPluginAsync } from "fastify";
import * as controller from "./profiles.controller.js";

const profilesRoutes: FastifyPluginAsync = async (app) => {
  /**
   * @openapi
   * /profiles:
   *   get:
   *     summary: All profile cards (username, displayName, avatarUrl, verified)
   *     tags: [Profiles]
   *     responses:
   *       200: { description: "{ items }" }
   */
  app.get("/", controller.list);

  /**
   * @openapi
   * /profiles/{username}:
   *   get:
   *     summary: Profile card with postsCount
   *     tags: [Profiles]
   *     parameters:
   *       - { in: path, name: username, required: true, schema: { type: string } }
   *     responses:
   *       200: { description: Profile }
   *       404: { description: Profile not found }
   */
  app.get("/:username", controller.getByUsername);
};

export default profilesRoutes;
