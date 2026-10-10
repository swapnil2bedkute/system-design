import type { FastifyReply, FastifyRequest } from "fastify";
import { ProductV2 } from "./productsv2.model.js";
import { ITEM_PROJECTION } from "./productsv2.schema.js";
import { searchProducts, syncDelete, syncIndex } from "./productsv2.search.js";
import {
  validateCreate,
  validateUpdate,
} from "../products/products.validation.js";
import { EsUnavailableError } from "../../bootstrap/elastic.js";
import { env } from "../../bootstrap/env.js";
import { logger } from "../../bootstrap/logger.js";
import { httpError } from "../../shared/error.js";
import { parseLimit, parsePage } from "../../shared/pagination.js";

// ponytail: fixed caps, not env vars. Same on both backends so the comparison stays fair.
const MAX_WINDOW = 10_000; // page * limit, matches ES max_result_window
const MAX_NAME_LEN = 100;
const MONGO_MAX_TIME_MS = 5000;
const OBJECT_ID = /^[0-9a-f]{24}$/i;

const queryOf = (req: FastifyRequest): Record<string, unknown> =>
  req.query as Record<string, unknown>;
const idOf = (req: FastifyRequest): string => (req.params as { id: string }).id;
const cleanStr = (v: unknown, max = 200): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;

const escapeRegex = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const parseCursor = (raw: unknown): string | undefined => {
  if (typeof raw !== "string" || !raw) return undefined;
  if (!OBJECT_ID.test(raw)) throw httpError(400, "Invalid cursor");
  return raw.toLowerCase();
};

// Mongo has no text index here, so name search is an escaped, case-insensitive contains (full scan)
const mongoFilter = (
  name?: string,
  category?: string,
): Record<string, unknown> => ({
  ...(category ? { category } : {}),
  ...(name ? { name: { $regex: escapeRegex(name), $options: "i" } } : {}),
});

// ENABLE_ES=true: try Elasticsearch first. If it is unavailable (down, or the circuit breaker is open)
// serve the same request from Mongo instead of failing it. null = "use Mongo". Any other error is real.
const tryEs = async <T>(run: () => Promise<T>): Promise<T | null> => {
  if (!env.enableEs) return null;
  try {
    return await run();
  } catch (err) {
    if (err instanceof EsUnavailableError) return null;
    throw err;
  }
};

// Says which store answered, in the X-Backend header and in the log, so a fallback is never silent.
const markBackend = (reply: FastifyReply, esAnswered: boolean): void => {
  const backend = esAnswered
    ? "elasticsearch"
    : env.enableEs
      ? "mongodb-fallback"
      : "mongodb";
  reply.header("X-Backend", backend);
  logger.http(`productsv2 list via ${backend}`);
};

// GET /productsv2?page=&limit=    -> page mode (totalItems, totalPages), max page*limit 10,000
// GET /productsv2?cursor=&limit=  -> cursor mode (default when no "page" query given)
// Backend: ENABLE_ES=true -> Elasticsearch, false -> Mongo (no extra indexes, so slow on big data)
export const list = async (
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> => {
  const query = queryOf(req);
  const limit = parseLimit(query.limit);
  const category = cleanStr(query.category);
  const name = cleanStr(query.name, MAX_NAME_LEN);

  if (query.page !== undefined) {
    const page = parsePage(query.page);
    if (page * limit > MAX_WINDOW) {
      throw httpError(
        400,
        `page * limit must be <= ${MAX_WINDOW}. Use cursor for deeper pages`,
      );
    }
    const from = (page - 1) * limit;

    let items: unknown[];
    let totalItems: number;
    const es = await tryEs(() =>
      searchProducts({ name, category, limit, from }),
    );
    markBackend(reply, es !== null);
    if (es) {
      items = es.items;
      totalItems = es.total ?? 0;
    } else {
      const filter = mongoFilter(name, category);
      const hasFilter = Object.keys(filter).length > 0;
      [items, totalItems] = await Promise.all([
        ProductV2.find(filter)
          .select(ITEM_PROJECTION)
          .sort({ _id: 1 })
          .skip(from)
          .limit(limit)
          .maxTimeMS(MONGO_MAX_TIME_MS)
          .lean(),
        hasFilter
          ? ProductV2.countDocuments(filter).maxTimeMS(MONGO_MAX_TIME_MS)
          : ProductV2.estimatedDocumentCount(),
      ]);
    }

    await reply.send({
      items,
      page,
      limit,
      totalItems,
      totalPages: Math.ceil(totalItems / limit),
    });
    return;
  }

  const cursor = parseCursor(query.cursor);
  let items: Array<{ _id: unknown }>;

  const es = await tryEs(() =>
    searchProducts({ name, category, limit, after: cursor }),
  );
  markBackend(reply, es !== null);
  if (es) {
    items = es.items;
  } else {
    items = await ProductV2.find({
      ...mongoFilter(name, category),
      ...(cursor ? { _id: { $gt: cursor } } : {}),
    })
      .select(ITEM_PROJECTION)
      .sort({ _id: 1 })
      .limit(limit)
      .maxTimeMS(MONGO_MAX_TIME_MS)
      .lean();
  }

  await reply.send({
    items,
    nextCursor:
      items.length < limit ? null : String(items[items.length - 1]._id),
  });
};

export const getById = async (
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> => {
  const product = await ProductV2.findById(idOf(req))
    .select(ITEM_PROJECTION)
    .lean();
  if (!product) throw httpError(404, "Product not found");
  await reply.send(product);
};

export const create = async (
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> => {
  const product = await ProductV2.create(validateCreate(req.body));
  await syncIndex(product);
  await reply.code(201).send(product);
};

export const update = async (
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> => {
  const product = await ProductV2.findByIdAndUpdate(
    idOf(req),
    validateUpdate(req.body),
    {
      new: true,
      runValidators: true,
    },
  );
  if (!product) throw httpError(404, "Product not found");
  await syncIndex(product);
  await reply.send(product);
};

export const remove = async (
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> => {
  const product = await ProductV2.findByIdAndDelete(idOf(req));
  if (!product) throw httpError(404, "Product not found");
  await syncDelete(String(product._id));
  await reply.send({ deleted: product });
};
