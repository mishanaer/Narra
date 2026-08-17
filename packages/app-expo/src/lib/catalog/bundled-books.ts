import type { BundledCatalogBookDefinition } from "./bundled-book-definitions";

/** @deprecated Catalog books are downloaded from the Narra backend. */
export interface BundledCatalogBook extends BundledCatalogBookDefinition {
  assetModule: number;
  coverAssetModule: number;
}

/** Empty by design: keeping this empty prevents Metro from bundling catalog assets. */
export const BUNDLED_CATALOG_BOOKS: readonly BundledCatalogBook[] = [];

export async function resolveBundledCatalogBookUri(_book: BundledCatalogBook): Promise<string> {
  throw new Error("Bundled catalog books are disabled; use the Narra backend catalog");
}

export async function resolveBundledCatalogCoverUri(_book: BundledCatalogBook): Promise<string> {
  throw new Error("Bundled catalog covers are disabled; use the Narra backend catalog");
}

export async function installBundledCatalogCover(
  _bookId: string,
  _catalogBook: BundledCatalogBook,
): Promise<string> {
  throw new Error("Bundled catalog covers are disabled; use the Narra backend catalog");
}

export function findBundledCatalogBookByTitle(_title: string): BundledCatalogBook | undefined {
  return undefined;
}

export { normalizeCatalogIdentity } from "./bundled-book-definitions";
