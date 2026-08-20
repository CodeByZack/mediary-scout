import { describe, expect, it } from "vitest";
import { hasChineseSubtitle, matchesPreference, pickSubtitle } from "../src/acquisition-v2/subtitle-picker.js";
import type { AssrtCandidate } from "../src/subtitle-provider.js";

function candidate(partial: Partial<AssrtCandidate> & { id: number; title: string }): AssrtCandidate {
  const out: AssrtCandidate = { id: partial.id, title: partial.title, lang: partial.lang ?? "" };
  // exactOptionalPropertyTypes: 可选属性只在确有值时赋值，绝不给 undefined。
  if (partial.voteScore !== undefined) out.voteScore = partial.voteScore;
  if (partial.releaseSite !== undefined) out.releaseSite = partial.releaseSite;
  if (partial.uploadTime !== undefined) out.uploadTime = partial.uploadTime;
  return out;
}

describe("subtitle-picker — deterministic 中字 package selection", () => {
  describe("hasChineseSubtitle", () => {
    it("detects Chinese-sub signals in the language tag", () => {
      expect(hasChineseSubtitle(candidate({ id: 1, title: "x", lang: "英 简" }))).toBe(true);
      expect(hasChineseSubtitle(candidate({ id: 2, title: "x", lang: "繁" }))).toBe(true);
      expect(hasChineseSubtitle(candidate({ id: 3, title: "x", lang: "双语" }))).toBe(true);
      expect(hasChineseSubtitle(candidate({ id: 4, title: "x", lang: "chs" }))).toBe(true);
      expect(hasChineseSubtitle(candidate({ id: 5, title: "x", lang: "英" }))).toBe(false);
      expect(hasChineseSubtitle(candidate({ id: 6, title: "x", lang: "en" }))).toBe(false);
      expect(hasChineseSubtitle(candidate({ id: 7, title: "x", lang: "" }))).toBe(false);
    });
  });

  describe("matchesPreference", () => {
    it("matches exact token against the language tag", () => {
      expect(matchesPreference(candidate({ id: 1, title: "x", lang: "英 简 双语" }), "简")).toBe(true);
      expect(matchesPreference(candidate({ id: 2, title: "x", lang: "英 繁" }), "繁")).toBe(true);
      expect(matchesPreference(candidate({ id: 3, title: "x", lang: "英 简" }), "繁")).toBe(false);
    });

    it("treats empty preference as match-all", () => {
      expect(matchesPreference(candidate({ id: 1, title: "x", lang: "英" }), "")).toBe(true);
    });

    it("fuzzy-matches 简体/简中/Chinese phrasings", () => {
      expect(matchesPreference(candidate({ id: 1, title: "x", lang: "简" }), "简体中文")).toBe(true);
      expect(matchesPreference(candidate({ id: 2, title: "x", lang: "繁" }), "繁体")).toBe(true);
      expect(matchesPreference(candidate({ id: 3, title: "x", lang: "英 简" }), "chinese")).toBe(true);
    });

    it("unknown tag cannot confirm a preference", () => {
      expect(matchesPreference(candidate({ id: 1, title: "x", lang: "" }), "简体")).toBe(false);
    });
  });

  describe("pickSubtitle", () => {
    it("returns null on an empty snapshot", () => {
      const pick = pickSubtitle([], { preferredLanguage: "" });
      expect(pick.picked).toBeNull();
      expect(pick.reason).toContain("无字幕候选");
    });

    it("prefers the language-preference match over a higher-voted non-match", () => {
      const candidates = [
        candidate({ id: 1, title: "A组 双语", lang: "英 简", voteScore: 3 }),
        candidate({ id: 2, title: "B组 高票", lang: "英", voteScore: 9 }),
      ];
      const pick = pickSubtitle(candidates, { preferredLanguage: "简" });
      expect(pick.picked?.id).toBe(1);
      expect(pick.reason).toContain("命中语言偏好");
    });

    it("within matching group, ranks by ★ vote score", () => {
      const candidates = [
        candidate({ id: 1, title: "低分匹配", lang: "简", voteScore: 2 }),
        candidate({ id: 2, title: "高分匹配", lang: "简", voteScore: 8 }),
      ];
      const pick = pickSubtitle(candidates, { preferredLanguage: "简" });
      expect(pick.picked?.id).toBe(2);
    });

    it("known-good 字幕组 breaks a ★ tie", () => {
      const candidates = [
        candidate({ id: 1, title: "路人组", lang: "简", voteScore: 5, releaseSite: "随便组" }),
        candidate({ id: 2, title: "YYeTs", lang: "简", voteScore: 5, releaseSite: "YYeTs" }),
      ];
      const pick = pickSubtitle(candidates, { preferredLanguage: "简" });
      expect(pick.picked?.id).toBe(2);
    });

    it("without a preference match, picks the best-voted overall (no preference)", () => {
      const candidates = [
        candidate({ id: 1, title: "低票", lang: "英", voteScore: 1 }),
        candidate({ id: 2, title: "高票", lang: "英", voteScore: 9 }),
      ];
      const pick = pickSubtitle(candidates, { preferredLanguage: "" });
      expect(pick.picked?.id).toBe(2);
      expect(pick.reason).toContain("命中");
    });

    it("handles missing voteScore gracefully", () => {
      const candidates = [
        candidate({ id: 1, title: "无分", lang: "简" }),
        candidate({ id: 2, title: "有分", lang: "简", voteScore: 4 }),
      ];
      const pick = pickSubtitle(candidates, { preferredLanguage: "简" });
      expect(pick.picked?.id).toBe(2);
    });
  });
});