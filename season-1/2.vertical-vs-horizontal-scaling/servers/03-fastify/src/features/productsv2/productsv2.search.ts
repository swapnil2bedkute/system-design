import type { estypes } from "@elastic/elasticsearch";
import { EsUnavailableError, esClient, withEs } from "../../bootstrap/elastic.js";
import { env } from "../../bootstrap/env.js";
import { logger } from "../../bootstrap/logger.js";

type QueryDslQueryContainer = estypes.QueryDslQueryContainer;

// ES only holds what /productsv2 returns or searches: no description, stock or dates (smaller index)
export interface EsProductSource {
  mongoId: string;
  name: string;
  price: number;
  category: string;
  imageUrl: string;
}

interface MongoLikeProduct {
  _id: unknown;
  name: string;
  price: number;
  category: string;
  imageUrl: string;
}

export const toEsDoc = (p: MongoLikeProduct): EsProductSource => ({
  mongoId: String(p._id),
  name: p.name,
  price: p.price,
  category: p.category,
  imageUrl: p.imageUrl,
});

// ES doc _id = Mongo _id (hex), so re-indexing the same product just overwrites it
export const bulkIndex = async (docs: MongoLikeProduct[]): Promise<{ failed: number }> => {
  if (docs.length === 0) return { failed: 0 };
  const operations = docs.flatMap((d) => [{ index: { _index: env.esIndex, _id: String(d._id) } }, toEsDoc(d)]);
  const res = await esClient().bulk({ operations, refresh: false });
  return { failed: res.errors ? res.items.filter((i) => i.index?.error).length : 0 };
};

// Write path: Mongo is the source of truth, so an ES failure is logged, never thrown.
// `pnpm reindex:productsv2` repairs any gap.
// breaker open = ES is skipped on purpose, so keep that quiet. withEs already logged real failures.
const skipped = (op: string, id: string, err: unknown): void => {
  if (err instanceof EsUnavailableError) logger.debug(`productsv2 ES ${op} skipped (circuit open) id=${id}`);
  else logger.error(`productsv2 ES ${op} failed id=${id}: ${err instanceof Error ? err.message : String(err)}`);
};

export const syncIndex = async (p: MongoLikeProduct): Promise<void> => {
  if (!env.enableEs) return;
  try {
    await withEs(() => esClient().index({ index: env.esIndex, id: String(p._id), document: toEsDoc(p) }));
  } catch (err) {
    skipped("index", String(p._id), err);
  }
};

export const syncDelete = async (id: string): Promise<void> => {
  if (!env.enableEs) return;
  try {
    await withEs(() => esClient().delete({ index: env.esIndex, id }, { ignore: [404] }));
  } catch (err) {
    skipped("delete", id, err);
  }
};

export interface SearchParams {
  name?: string;
  category?: string;
  limit: number;
  // exactly one of these is set: page mode (from) or cursor mode (after, may be undefined for first page)
  from?: number;
  after?: string;
}

export interface SearchResult {
  items: Array<Omit<EsProductSource, "mongoId"> & { _id: string }>;
  total: number | null;
}

export const searchProducts = async (p: SearchParams): Promise<SearchResult> => {
  const filter: QueryDslQueryContainer[] = [];
  if (p.category) filter.push({ term: { category: p.category } });
  const must: QueryDslQueryContainer[] = p.name ? [{ match: { name: { query: p.name, operator: "and" } } }] : [];

  const res = await withEs(() =>
    esClient().search<EsProductSource>({
      index: env.esIndex,
      size: p.limit,
      timeout: "2s",
      sort: [{ mongoId: "asc" }],
      query: { bool: { filter, must } },
      // exact total only in page mode; cursor mode never needs it
      track_total_hits: p.from !== undefined,
      ...(p.from !== undefined ? { from: p.from } : {}),
      ...(p.after ? { search_after: [p.after] } : {}),
    }),
  );

  // same item shape as /products: _id instead of the ES-only mongoId field
  const items = res.hits.hits.map((h) => {
    const { mongoId, ...rest } = h._source as EsProductSource;
    return { _id: mongoId, ...rest };
  });
  const total = typeof res.hits.total === "number" ? res.hits.total : (res.hits.total?.value ?? null);
  return { items, total };
};
