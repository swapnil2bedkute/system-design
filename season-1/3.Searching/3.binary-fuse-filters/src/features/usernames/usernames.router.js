import * as controller from "./usernames.controller.js";

const usernameSchema = { type: "string", pattern: "^[A-Za-z0-9_]{3,30}$" };

const usernamesRoutes = async (app) => {
  app.post(
    "/add-username",
    {
      schema: {
        body: {
          type: "object",
          required: ["username"],
          properties: { username: usernameSchema },
        },
      },
    },
    controller.addUsername,
  );

  app.get(
    "/check-username",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["username"],
          properties: {
            username: usernameSchema,
            consistency: {
              type: "string",
              enum: ["strong", "eventual"],
              default: "eventual",
            },
          },
        },
        // with a response schema Fastify serializes the ES / Mongo answers with a compiled function instead of JSON.stringify
        response: {
          200: {
            type: "object",
            properties: {
              username: { type: "string" },
              result: { type: "string" },
              fuseFilter: { type: "string" },
              checkedIn: { type: "string" },
              reason: { type: "string" },
            },
          },
        },
      },
    },
    controller.checkUsername,
  );

  // straight to Mongo every time: no filter, no Elasticsearch
  app.get(
    "/check-username-in-db",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["username"],
          properties: { username: usernameSchema },
        },
      },
    },
    controller.checkUsernameInDb,
  );

  app.delete(
    "/delete-username",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["username"],
          properties: { username: usernameSchema },
        },
      },
    },
    controller.deleteUsername,
  );

  // ponytail: waits for the whole ingest, fine up to ~10 lakh. Bigger needs a background job.
  app.post(
    "/ingest",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            count: {
              type: "integer",
              minimum: 1,
              maximum: 1000000,
              default: 20000,
            },
          },
        },
      },
    },
    controller.ingest,
  );

  app.get("/stats", controller.stats);

  app.get(
    "/fp-test",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            n: {
              type: "integer",
              minimum: 1,
              maximum: 1000000,
              default: 10000,
            },
          },
        },
      },
    },
    controller.fp,
  );
};

export default usernamesRoutes;
