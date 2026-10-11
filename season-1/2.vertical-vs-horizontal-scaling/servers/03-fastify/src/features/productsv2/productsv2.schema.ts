// Response schemas for /productsv2. Fastify compiles these with fast-json-stringify:
// it writes ONLY the listed fields, so description / stock / createdAt / updatedAt / __v never leave the
// server, and the JSON is built faster than JSON.stringify. A field missing here is dropped silently.
// ponytail: only the 2xx success shapes. Errors keep going through errorHandler as { error }.
const itemSchema = {
  type: "object",
  properties: {
    _id: { type: "string" },
    name: { type: "string" },
    price: { type: "number" },
    category: { type: "string" },
    imageUrl: { type: "string" },
  },
} as const;

// one schema for both list modes: cursor sends items + nextCursor, page sends items + the page fields
const listSchema = {
  type: "object",
  properties: {
    items: { type: "array", items: itemSchema },
    nextCursor: { type: ["string", "null"] },
    page: { type: "integer" },
    limit: { type: "integer" },
    totalItems: { type: "integer" },
    totalPages: { type: "integer" },
  },
} as const;

const deletedSchema = {
  type: "object",
  properties: { deleted: itemSchema },
} as const;

export const listRoute = { schema: { response: { 200: listSchema } } };
export const itemRoute = { schema: { response: { 200: itemSchema } } };
export const createRoute = { schema: { response: { 201: itemSchema } } };
export const deleteRoute = { schema: { response: { 200: deletedSchema } } };

// Mongo projection that matches the schema above (no description, stock, dates or __v)
export const ITEM_PROJECTION = "name price category imageUrl";
