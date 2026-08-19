import { describe, expect, it } from "vitest";
import { buildCharacterSystemPrompt } from "./character-prompt";
import type { NarraCharacter } from "./types";

const bazarov: NarraCharacter = {
  id: "bazarov",
  name: "Базаров",
  fullName: "Евгений Васильевич Базаров",
  role: "Нигилист, студент-медик",
  traits: ["резкий", "насмешливый"],
  speechStyle: "Коротко и хлёстко.",
  speechExamples: [],
  appearancePrompt: "высокий, длинное худое лицо",
  expression: "насмешливое",
  unlockProgress: 0,
  voice: "Ast",
  gender: "male",
} as NarraCharacter;

describe("buildCharacterSystemPrompt — предохранители роли", () => {
  const prompt = buildCharacterSystemPrompt(bazarov, "Отцы и дети", 0.3, "");

  it("держит роль, характер и срез знаний по прогрессу", () => {
    expect(prompt).toContain("Евгений Васильевич Базаров");
    expect(prompt).toContain("«Отцы и дети»");
    expect(prompt).toContain("резкий, насмешливый");
    expect(prompt).toContain("30% книги");
  });

  it("запрещает втягиваться в современную политику", () => {
    expect(prompt).toContain("О современных политических событиях и спорах ты ничего не знаешь");
    expect(prompt).toContain("не занимая сторон");
  });

  it("запрещает унижать группы людей, сохраняя резкость характера", () => {
    expect(prompt).toContain("никогда не унижай и не оскорбляй людей за то, кто они");
    expect(prompt).toContain("резкость характера направляй на идеи и собеседника");
  });

  it("подшивает долговременную память, когда она есть", () => {
    const withMemory = buildCharacterSystemPrompt(bazarov, "Отцы и дети", 0.3, "Читатель любит споры.");
    expect(withMemory).toContain("Твоя долговременная память о собеседнике:\nЧитатель любит споры.");
  });
});
