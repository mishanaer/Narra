/**
 * Генерация изображений сцен через OpenRouter (P16) — единая точка входа.
 *
 * Путь тот же, что у обложек (generate-book-cover.ts): POST {baseUrl}/images
 * со встроенным ключом из bundled-ai. Общий клиент сначала использует
 * GPT Image 2, а при его ошибке — stable Nano Banana 2. Оба запроса идут
 * только через OpenRouter; gateway/Kandinsky в runtime-пути сцены нет.
 *
 * Референс-изображения (портреты героев) эндпоинт /images НЕ учитывает:
 * живой вызов 2026-08 принимает поле image, но игнорирует его содержимое,
 * поэтому консистентность героев держим паспортами внешности в промпте.
 */

import {
  OPENROUTER_PRIMARY_IMAGE_MODEL,
  type OpenRouterImageRequest,
  generateOpenRouterImage,
} from "@/lib/ai/openrouter-image";
import { useLibraryStore, useNarraStore } from "@/stores";
import { persistSceneImageBase64, trackNarraMediaJob } from "./media";
import sceneGenerationConfig from "./scene-generation-config.json";
import { buildScenePrompt } from "./scene-prompt";
import type { NarraCharacter } from "./types";

const SCENE_MODEL = OPENROUTER_PRIMARY_IMAGE_MODEL;

/** Метаданные книги для блоков «эпоха/мир» и жанра (лениво, вне юнит-тестов). */
function bookMetaForPrompt(bookId: string): {
  title: string;
  author?: string;
  description?: string;
  subjects?: string[];
} {
  const book = useLibraryStore.getState().books.find((item) => item.id === bookId);
  return {
    title: book?.meta.title ?? "",
    author: book?.meta.author || undefined,
    description: book?.meta.description || undefined,
    subjects: book?.meta.subjects,
  };
}

/**
 * Отрывки 1–2 последних сцен книги из narra-store — контекст «ранее в книге»
 * для связной серии иллюстраций. Текущий отрывок исключается (перегенерация).
 */
function previousSceneExcerpts(bookId: string, currentExcerpt: string): string[] {
  const scenes = useNarraStore.getState().books[bookId]?.scenes;
  if (!scenes) return [];
  return Object.values(scenes)
    .filter((scene) => scene.imageUri && scene.excerpt && scene.excerpt !== currentExcerpt)
    .sort((a, b) => b.generatedAt - a.generatedAt)
    .slice(0, 2)
    .map((scene) => scene.excerpt);
}

async function generateSceneImageViaOpenRouter(
  bookId: string,
  chapter: string,
  excerpt: string,
  characters: NarraCharacter[],
): Promise<string> {
  const book = bookMetaForPrompt(bookId);
  const prompt = buildScenePrompt({
    bookTitle: book.title,
    bookAuthor: book.author,
    bookDescription: book.description,
    bookSubjects: book.subjects,
    chapter,
    excerpt,
    characters,
    previousExcerpts: previousSceneExcerpts(bookId, excerpt),
  });

  const image = await generateOpenRouterImage({
    model: SCENE_MODEL,
    prompt,
    aspectRatio: sceneGenerationConfig.aspectRatio as OpenRouterImageRequest["aspectRatio"],
    quality: sceneGenerationConfig.quality as OpenRouterImageRequest["quality"],
    outputFormat: sceneGenerationConfig.outputFormat as OpenRouterImageRequest["outputFormat"],
    outputCompression: sceneGenerationConfig.outputCompression,
  });
  const extension = image.mimeType === "image/png" ? "png" : "jpg";
  return persistSceneImageBase64(bookId, image.base64, extension);
}

/**
 * Единая точка генерации сцены через OpenRouter. Model fallback реализован
 * внутри generateOpenRouterImage и одинаков для сцен, обложек и портретов.
 */
export async function generateNarraSceneImage(
  bookId: string,
  chapter: string,
  excerpt: string,
  characters: NarraCharacter[],
): Promise<string> {
  return trackNarraMediaJob(
    "image",
    "user",
    () => generateSceneImageViaOpenRouter(bookId, chapter, excerpt, characters),
    { provider: "openrouter", model: SCENE_MODEL },
  );
}
