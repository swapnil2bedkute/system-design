import type { FastifyPluginAsync } from "fastify";
import * as controller from "./productsv2.controller.js";
import { createRoute, deleteRoute, itemRoute, listRoute } from "./productsv2.schema.js";

const productsV2Routes: FastifyPluginAsync = async (app) => {
  /**
   * @openapi
   * /productsv2:
   *   get:
   *     summary: List products from Elasticsearch (ENABLE_ES=true) or Mongo (false). Page and cursor modes
   *     tags: [ProductsV2]
   *     parameters:
   *       - in: query
   *         name: page
   *         schema: { type: integer, minimum: 1 }
   *         description: Page mode. page * limit must be <= 10000
   *       - in: query
   *         name: cursor
   *         schema: { type: string }
   *         description: Last _id of the previous page. Ignored if "page" is given
   *       - in: query
   *         name: name
   *         schema: { type: string, maxLength: 100 }
   *       - in: query
   *         name: limit
   *         schema: { type: integer, maximum: 100, default: 20 }
   *       - in: query
   *         name: category
   *         schema: { type: string }
   *     responses:
   *       200: { description: Product list }
   *       400: { description: Bad cursor or page * limit over 10000 }
   *       503: { description: Search backend unavailable }
   */
  app.get("/", listRoute, controller.list);

  /**
   * @openapi
   * /productsv2/{id}:
   *   get:
   *     summary: Get product by id (Mongo)
   *     tags: [ProductsV2]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200: { description: Product }
   *       404: { description: Not found }
   */
  app.get("/:id", itemRoute, controller.getById);

  /**
   * @openapi
   * /productsv2:
   *   post:
   *     summary: Create product (Mongo, then ES if enabled)
   *     tags: [ProductsV2]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [name, description, price, stock, category, imageUrl]
   *             properties:
   *               name: { type: string }
   *               description: { type: string }
   *               price: { type: number }
   *               stock: { type: integer }
   *               category: { type: string }
   *               imageUrl: { type: string }
   *     responses:
   *       201: { description: Created }
   *       400: { description: Validation error }
   */
  app.post("/", createRoute, controller.create);

  /**
   * @openapi
   * /productsv2/{id}:
   *   put:
   *     summary: Update product
   *     tags: [ProductsV2]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200: { description: Updated }
   *       404: { description: Not found }
   */
  app.put("/:id", itemRoute, controller.update);

  /**
   * @openapi
   * /productsv2/{id}:
   *   delete:
   *     summary: Delete product
   *     tags: [ProductsV2]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200: { description: Deleted }
   *       404: { description: Not found }
   */
  app.delete("/:id", deleteRoute, controller.remove);
};

export default productsV2Routes;
