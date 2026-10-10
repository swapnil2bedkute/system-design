import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    server: "src/server.ts",
    "seed-products": "src/seed/seed-products.ts",
    "reindex-productsv2": "src/seed/reindex-productsv2.ts",
  },
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  sourcemap: true,
  bundle: true,
});
