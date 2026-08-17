import * as FileSystem from "expo-file-system/legacy";
import { type BackendCatalogBook, requestBackendDownloadUrl } from "./backend-catalog-api";
import { sha256BackendFile } from "./backend-file-hash";

const IMPORT_CACHE_ROOT = `${FileSystem.cacheDirectory}narra-catalog-import`;

function safePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 120);
}

function safeExtension(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "") || "epub";
}

export async function downloadBackendCatalogSource(book: BackendCatalogBook): Promise<string> {
  const cacheInfo = await FileSystem.getInfoAsync(IMPORT_CACHE_ROOT);
  if (!cacheInfo.exists) {
    await FileSystem.makeDirectoryAsync(IMPORT_CACHE_ROOT, { intermediates: true });
  }
  const filePath = `${IMPORT_CACHE_ROOT}/${safePart(book.catalogKey)}-${safePart(
    book.bookEditionId,
  )}.${safeExtension(book.format)}`;
  await FileSystem.deleteAsync(filePath, { idempotent: true });

  const downloadUrl = await requestBackendDownloadUrl(book.sourceDownloadPath);
  const result = await FileSystem.createDownloadResumable(downloadUrl, filePath, {
    sessionType: FileSystem.FileSystemSessionType.BACKGROUND,
  }).downloadAsync();
  if (!result || result.status < 200 || result.status >= 300) {
    await FileSystem.deleteAsync(filePath, { idempotent: true });
    throw new Error(`Backend catalog download failed (${result?.status ?? "cancelled"})`);
  }
  if ((await sha256BackendFile(filePath)).toLowerCase() !== book.contentSha256) {
    await FileSystem.deleteAsync(filePath, { idempotent: true });
    throw new Error("Backend catalog checksum mismatch");
  }
  return filePath;
}

export async function cleanupBackendCatalogSource(filePath: string | null): Promise<void> {
  if (!filePath || !filePath.startsWith(IMPORT_CACHE_ROOT)) return;
  await FileSystem.deleteAsync(filePath, { idempotent: true });
}
