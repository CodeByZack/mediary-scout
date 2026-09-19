import { describe, expect, it } from "vitest";
import { classifyMediaType } from "../src/index.js";

describe("classifyMediaType", () => {
  it("classifies a Japanese animation series as anime", () => {
    expect(
      classifyMediaType({ baseType: "tv", genreIds: [16, 10765], originCountries: ["JP"] }),
    ).toBe("anime");
  });

  it("classifies a Chinese animation series (国漫) as anime", () => {
    // 国漫 (e.g. 一人之下): Animation genre + CN origin → 动漫 shelf, like 日漫.
    expect(classifyMediaType({ baseType: "tv", genreIds: [16], originCountries: ["CN"] })).toBe(
      "anime",
    );
  });

  it("keeps a Japanese animated MOVIE as a movie (a film is a film)", () => {
    // 你的名字 / 千与千寻: animation genre + JP, but a movie stays a movie — it
    // belongs on the 电影 shelf and routes to the movie agent, not 动漫.
    expect(classifyMediaType({ baseType: "movie", genreIds: [16], originCountries: ["JP"] })).toBe(
      "movie",
    );
  });

  it("keeps a Chinese animated MOVIE as a movie too", () => {
    expect(classifyMediaType({ baseType: "movie", genreIds: [16], originCountries: ["CN"] })).toBe(
      "movie",
    );
  });

  it("classifies a Western animation series (美漫, e.g. 无敌少侠) as anime — any animation counts", () => {
    expect(classifyMediaType({ baseType: "tv", genreIds: [16], originCountries: ["US"] })).toBe(
      "anime",
    );
  });

  it("classifies a Korean animation series as anime too (origin no longer matters)", () => {
    expect(classifyMediaType({ baseType: "tv", genreIds: [16], originCountries: ["KR"] })).toBe(
      "anime",
    );
  });

  it("classifies an animation series with no origin info as anime (genre is the only signal)", () => {
    expect(classifyMediaType({ baseType: "tv", genreIds: [16], originCountries: [] })).toBe("anime");
  });

  it("keeps a live-action Japanese series as tv (animation genre required)", () => {
    expect(classifyMediaType({ baseType: "tv", genreIds: [18], originCountries: ["JP"] })).toBe("tv");
  });

  it("falls back to the base type when genre/origin are unknown", () => {
    expect(classifyMediaType({ baseType: "movie", genreIds: [], originCountries: [] })).toBe("movie");
    expect(classifyMediaType({ baseType: "tv", genreIds: [], originCountries: [] })).toBe("tv");
  });

  describe("variety — TMDB 无综艺 genre,真人秀 10764 是唯一判据", () => {
    it("classifies the sampled 综艺 as variety (8/8 实测样本均带 10764)", () => {
      // 花儿与少年/地球超新鲜/中餐厅/密室大逃脱 [10764]、奔跑吧 [35,10764]、
      // 喜人奇妙夜 [10764,35] —— genre 顺序不敏感。
      for (const genreIds of [[10764], [35, 10764], [10764, 35], [10764, 99]]) {
        expect(classifyMediaType({ baseType: "tv", genreIds, originCountries: ["CN"] })).toBe("variety");
      }
    });

    it("anime wins over variety when both genres are set (动漫衍生综艺归动漫架)", () => {
      expect(classifyMediaType({ baseType: "tv", genreIds: [16, 10764], originCountries: ["CN"] })).toBe("anime");
    });

    it("keeps a Reality-genre MOVIE as a movie (电影永不改判)", () => {
      expect(classifyMediaType({ baseType: "movie", genreIds: [10764], originCountries: ["CN"] })).toBe("movie");
    });

    it("does NOT fold in 10767 脱口秀 (欧美夜谈留剧集架,方案 §7.1 拍板)", () => {
      expect(classifyMediaType({ baseType: "tv", genreIds: [10767], originCountries: ["US"] })).toBe("tv");
    });

    it("keeps non-reality non-animation series as tv", () => {
      expect(classifyMediaType({ baseType: "tv", genreIds: [18], originCountries: ["CN"] })).toBe("tv");
      expect(classifyMediaType({ baseType: "tv", genreIds: [], originCountries: [] })).toBe("tv");
    });
  });
});
