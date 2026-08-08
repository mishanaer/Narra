import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/openrouter-image", () => ({ generateOpenRouterImage: vi.fn() }));
vi.mock("@/lib/ai/narra-gateway-fetch", () => ({ narraGatewayRequest: vi.fn() }));
vi.mock("@/stores", () => ({
  useLibraryStore: {
    getState: () => ({
      books: [
        {
          id: "book-1",
          meta: { title: "Test Book", author: "Test Author", subjects: ["fiction"] },
        },
      ],
    }),
  },
  useNarraStore: { getState: () => ({ books: {} }) },
}));
vi.mock("./media", () => ({
  persistSceneImageBase64: vi.fn(async () => "file:///scene.png"),
  trackNarraMediaJob: vi.fn(
    async (_jobType: string, _origin: string, operation: () => Promise<unknown>) => operation(),
  ),
}));

import { narraGatewayRequest } from "@/lib/ai/narra-gateway-fetch";
import { generateOpenRouterImage } from "@/lib/ai/openrouter-image";
import { generateNarraSceneImage } from "./scene-image-openrouter";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("generateNarraSceneImage", () => {
  it("never calls the Narra gateway or Kandinsky", async () => {
    vi.mocked(generateOpenRouterImage).mockResolvedValueOnce({
      base64: "iVBORw0KGgoAAA",
      mimeType: "image/png",
    });

    await expect(generateNarraSceneImage("book-1", "Chapter", "A quiet scene", [])).resolves.toBe(
      "file:///scene.png",
    );

    expect(generateOpenRouterImage).toHaveBeenCalledOnce();
    expect(narraGatewayRequest).not.toHaveBeenCalled();
  });

  it("propagates the diagnostic OpenRouter error instead of using the gateway", async () => {
    vi.mocked(generateOpenRouterImage).mockRejectedValueOnce(
      new Error("GPT Image 2 failed; Nano Banana 2 failed"),
    );

    await expect(generateNarraSceneImage("book-1", "Chapter", "A quiet scene", [])).rejects.toThrow(
      "GPT Image 2 failed; Nano Banana 2 failed",
    );
    expect(narraGatewayRequest).not.toHaveBeenCalled();
  });
});
