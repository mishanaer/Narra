/**
 * Compatibility surface for data imported by older builds.
 *
 * The catalog itself is intentionally empty: current builds load books from
 * the Narra backend and must not reference EPUB or cover assets at bundle time.
 */
export interface BundledCatalogBookDefinition {
  id: string;
  title: string;
  author: string;
  fileName: string;
  coverTextTone: "dark" | "light";
}

export const BUNDLED_CATALOG_COVER_VERSION = 7;
export const BUNDLED_CATALOG_BOOK_DEFINITIONS: readonly BundledCatalogBookDefinition[] = [];

export function getBundledCatalogCoverPath(bookId: string): string {
  return `covers/${bookId}-catalog-v${BUNDLED_CATALOG_COVER_VERSION}.jpg`;
}

export function isBundledCatalogCoverPath(bookId: string, coverUrl?: string): boolean {
  if (!coverUrl) return false;
  const escapedBookId = bookId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^covers/${escapedBookId}-catalog(?:-v\\d+)?\\.jpg$`).test(coverUrl);
}

export function shouldRefreshBundledCatalogCover(bookId: string, coverUrl?: string): boolean {
  return (
    !coverUrl ||
    (coverUrl !== getBundledCatalogCoverPath(bookId) && isBundledCatalogCoverPath(bookId, coverUrl))
  );
}

export function normalizeCatalogIdentity(value: string): string {
  return value.trim().toLocaleLowerCase("ru-RU").replace(/ё/g, "е").replace(/\s+/g, " ");
}

export function findBundledCatalogBookDefinitionByTitle(
  _title: string,
): BundledCatalogBookDefinition | undefined {
  return undefined;
}
