import mongoose, { Schema } from "mongoose";
import type { ProductDocument } from "../products/products.types.js";

// Same shape as products, but its own collection and NO extra indexes: only the default _id index.
// List/search/pagination is served by Elasticsearch (or a plain Mongo scan when ENABLE_ES=false).
const productV2Schema = new Schema<ProductDocument>(
  {
    name: { type: String, required: [true, "Product name is required"], trim: true },
    description: { type: String, required: [true, "Product description is required"], trim: true },
    price: { type: Number, required: [true, "Product price is required"], min: 0 },
    stock: { type: Number, required: [true, "Product stock is required"], min: 0 },
    category: { type: String, required: [true, "Product category is required"], trim: true },
    imageUrl: { type: String, required: [true, "Product image URL is required"] },
  },
  // versionKey false: no __v written on new docs (the response schema hides it anyway)
  { timestamps: true, collection: "productsv2", autoIndex: false, versionKey: false },
);

export const ProductV2 = mongoose.model<ProductDocument>("ProductV2", productV2Schema);
