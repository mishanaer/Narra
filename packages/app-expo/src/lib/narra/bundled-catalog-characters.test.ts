import { describe, expect, it } from "vitest";
import {
  getBundledCatalogCharactersById,
  getBundledCatalogCharactersByTitle,
} from "./bundled-catalog-characters";

describe("bundled catalog characters", () => {
  it("does not expose characters embedded in the app bundle", () => {
    expect(getBundledCatalogCharactersById("anna-karenina")).toBeUndefined();
    expect(getBundledCatalogCharactersByTitle("Анна Каренина")).toBeUndefined();
  });
});
