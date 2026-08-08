import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/openrouter-image", () => ({
  OPENROUTER_PRIMARY_IMAGE_MODEL: "openai/gpt-image-2",
  generateOpenRouterImage: vi.fn(),
}));
vi.mock("@/lib/ai/narra-gateway-fetch", () => ({ narraGatewayRequest: vi.fn() }));
vi.mock("@/stores", () => ({
  useLibraryStore: {
    getState: () => ({
      books: [
        {
          id: "book-1",
          meta: { title: "Анна Каренина", author: "Лев Толстой" },
        },
      ],
    }),
  },
  useNarraStore: {
    getState: () => ({ books: {} }),
  },
}));
vi.mock("./media", () => ({
  persistSceneImageBase64: vi.fn(async () => "file:///documents/narra-media/scene.png"),
  trackNarraMediaJob: vi.fn(
    async (_jobType: string, _origin: string, operation: () => Promise<unknown>) => operation(),
  ),
}));

import { narraGatewayRequest } from "@/lib/ai/narra-gateway-fetch";
import { generateOpenRouterImage } from "@/lib/ai/openrouter-image";
import { persistSceneImageBase64 } from "./media";
import { generateNarraSceneImage } from "./scene-image-openrouter";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("generateNarraSceneImage", () => {
  it("uses the shared GPT Image 2 → Nano Banana OpenRouter pipeline", async () => {
    vi.mocked(generateOpenRouterImage).mockResolvedValueOnce({
      base64: "iVBORw0KGgoSCENE",
      mimeType: "image/png",
    });

    await expect(generateNarraSceneImage("book-1", "Бал", "Анна вошла в зал.", [])).resolves.toBe(
      "file:///documents/narra-media/scene.png",
    );

    expect(generateOpenRouterImage).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "openai/gpt-image-2",
        aspectRatio: "3:2",
        quality: "medium",
        outputFormat: "jpeg",
      }),
    );
    expect(persistSceneImageBase64).toHaveBeenCalledWith("book-1", "iVBORw0KGgoSCENE", "png");
    expect(narraGatewayRequest).not.toHaveBeenCalled();
  });

  it("surfaces a complete OpenRouter failure without calling gateway/Kandinsky", async () => {
    vi.mocked(generateOpenRouterImage).mockRejectedValueOnce(
      new Error("GPT Image 2 and Nano Banana failed"),
    );

    await expect(generateNarraSceneImage("book-1", "Бал", "Анна вошла в зал.", [])).rejects.toThrow(
      "GPT Image 2 and Nano Banana failed",
    );

    expect(narraGatewayRequest).not.toHaveBeenCalled();
    expect(persistSceneImageBase64).not.toHaveBeenCalled();
  });
});
