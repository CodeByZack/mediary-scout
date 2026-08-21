import { describe, expect, it } from "vitest";
import {
  canonicalEpisodeFileName,
  canonicalMovieFileName,
  cleanTitleForCanonicalName,
  episodeCodeFromFileName,
} from "../src/index.js";

describe("episodeCodeFromFileName", () => {
  it("parses standard SxxExx names", () => {
    expect(episodeCodeFromFileName("Show.S02E12.2160p.mkv")).toBe("S02E12");
    expect(episodeCodeFromFileName("show s01e05.mkv")).toBe("S01E05");
  });

  it("parses 4-digit episode numbers for 1000+ episode anime (One Piece etc.)", () => {
    // \d{1,3} truncated "E1050" -> "E105"; long-running anime needs 4 digits.
    expect(episodeCodeFromFileName("One.Piece.S01E1050.mkv")).toBe("S01E1050");
    expect(episodeCodeFromFileName("海贼王 第1050集.mp4")).toBe("S01E1050");
  });

  it("does not mistake a stray non-episode number for the episode", () => {
    // No [Ee] prefix before 2160 — quality, not an episode.
    expect(episodeCodeFromFileName("Show.S01E05.2160p.mkv")).toBe("S01E05");
    expect(episodeCodeFromFileName("Movie.2023.2160p.mkv")).toBeNull();
  });
});

describe("canonicalEpisodeFileName", () => {
  it("builds Title.SxxExx.ext and carries the source extension through", () => {
    expect(canonicalEpisodeFileName({ title: "Show", episodeCode: "S01E01", sourceName: "Show - 01.mkv" })).toBe(
      "Show.S01E01.mkv",
    );
    expect(
      canonicalEpisodeFileName({ title: "庆余年", episodeCode: "S03E03", sourceName: "第3集.mp4" }),
    ).toBe("庆余年.S03E03.mp4");
  });

  it("falls back to an empty extension when the source has none", () => {
    // A bare "Show.01" WOULD be read as extension ".01" (/\.[A-Za-z0-9]+$/);
    // a truly extension-less source falls back to "".
    expect(canonicalEpisodeFileName({ title: "Show", episodeCode: "S01E01", sourceName: "Show" })).toBe(
      "Show.S01E01",
    );
    expect(canonicalEpisodeFileName({ title: "Show", episodeCode: "S01E01", sourceName: "Show.01" })).toBe(
      "Show.S01E01.01",
    );
  });
});

describe("canonicalMovieFileName", () => {
  it("builds Title (Year).ext", () => {
    expect(canonicalMovieFileName({ title: "奥本海默", year: 2023, sourceName: "Oppenheimer.2023.2160p.mkv" })).toBe(
      "奥本海默 (2023).mkv",
    );
  });

  it("accepts a pre-formatted string year and carries a multi-dot extension", () => {
    expect(canonicalMovieFileName({ title: "Inception", year: "2010", sourceName: "Inception.2010.1080p.mkv" })).toBe(
      "Inception (2010).mkv",
    );
    expect(canonicalMovieFileName({ title: "Movie", year: 2001, sourceName: "movie.WEB-DL.mp4" })).toBe(
      "Movie (2001).mp4",
    );
  });
});

describe("cleanTitleForCanonicalName", () => {
  it("strips episode-code-shaped substrings (SxxExx / 第N集) so the canonical name cannot be mis-parsed", () => {
    expect(cleanTitleForCanonicalName("庆余年 S01E01 全集")).toBe("庆余年 全集");
    expect(cleanTitleForCanonicalName("Show S01E05 E06")).toBe("Show E06"); // SxxExx removed, bare E06 kept
    expect(cleanTitleForCanonicalName("海贼王 第1050集")).toBe("海贼王");
  });

  it("removes filename-illegal characters", () => {
    expect(cleanTitleForCanonicalName('Show: The "Best" <One>?')).toBe("Show The Best One");
    expect(cleanTitleForCanonicalName("a/b\\c|d*e")).toBe("abcde");
  });

  it("folds leftover whitespace and trims", () => {
    expect(cleanTitleForCanonicalName("  庆余年   S01E01  ")).toBe("庆余年");
  });

  it("leaves a clean title untouched", () => {
    expect(cleanTitleForCanonicalName("庆余年")).toBe("庆余年");
    expect(cleanTitleForCanonicalName("The.Dark.Knight")).toBe("The.Dark.Knight");
  });
});
describe("episodeCodeFromFileName — 2026-08-19 补齐的命名规则 (§3)", () => {
  it("parses bare E01 / EP01 / Ep.01 (single-season context)", () => {
    expect(episodeCodeFromFileName("Show.E01.mkv", [1])).toBe("S01E01");
    expect(episodeCodeFromFileName("Show.EP12.mkv", [1])).toBe("S01E12");
    expect(episodeCodeFromFileName("Show.Ep.03.mkv", [1])).toBe("S01E03");
    // 2026-08-21 放开:单季(S03)任务里 E 编号落到目标季
    expect(episodeCodeFromFileName("Show.E08.mkv", [3])).toBe("S03E08");
  });

  it("parses 1×01 / 1x01 (Plex-style season×episode)", () => {
    expect(episodeCodeFromFileName("Show.1×01.mkv", [1])).toBe("S01E01");
    expect(episodeCodeFromFileName("Show 1x07.mkv", [1])).toBe("S01E07");
    // 多季上下文:无季信息的无季规则不启用,季不明 → 交仲裁
    expect(episodeCodeFromFileName("Show.2×03.mkv", [1, 2])).toBeNull();
  });

  it("parses 第N话 (anime wording)", () => {
    expect(episodeCodeFromFileName("海贼王 第5话.mkv", [1])).toBe("S01E05");
    expect(episodeCodeFromFileName("名侦探柯南 第1050话.mkv", [1])).toBe("S01E1050");
    // 2026-08-21 放开:单季(S03)任务里中文集数落到目标季
    expect(episodeCodeFromFileName("末日地堡 第8集.mkv", [3])).toBe("S03E08");
  });

  it("parses a pure-numeric filename (anime fansub 01.mp4) in ANY single-season task", () => {
    expect(episodeCodeFromFileName("01.mp4", [1])).toBe("S01E01");
    expect(episodeCodeFromFileName("39.mp4", [1])).toBe("S01E39");
    // 2026-08-21 放开:单季任务直接用目标季,不再死守 S01
    expect(episodeCodeFromFileName("08.mkv", [3])).toBe("S03E08");
    expect(episodeCodeFromFileName("01.mkv", [3])).toBe("S03E01");
  });

  it("does NOT parse pure numbers in a multi-season context (season unknown → arbitrator)", () => {
    expect(episodeCodeFromFileName("01.mp4", [1, 2])).toBeNull();
    expect(episodeCodeFromFileName("07.mp4", [])).toBeNull(); // 空季=电影,不算
  });

  it("does NOT parse a title with a stray number ('Show 01')", () => {
    expect(episodeCodeFromFileName("Show 01.mkv", [1])).toBeNull();
    expect(episodeCodeFromFileName("Show 1080p.mkv", [1])).toBeNull();
  });

  it("does NOT parse years / resolutions / CRC-looking numbers as episodes", () => {
    expect(episodeCodeFromFileName("2024.mp4", [1])).toBeNull(); // 年份
    expect(episodeCodeFromFileName("1080.mp4", [1])).toBeNull(); // 分辨率
    expect(episodeCodeFromFileName("2160.mkv", [1])).toBeNull();
    expect(episodeCodeFromFileName("4F14C2AE.mkv", [1])).toBeNull(); // CRC
  });

  it("parses loose variants: 'S01 E01' and 's01.e01'", () => {
    expect(episodeCodeFromFileName("Show S01 E01.mkv", [1])).toBe("S01E01");
    expect(episodeCodeFromFileName("Show.s01.e01.mkv", [1])).toBe("S01E01");
  });

  it("parses multi-episode packs by their start code ('S01E01-E03')", () => {
    expect(episodeCodeFromFileName("Show.S01E01-E03.mkv", [1])).toBe("S01E01");
  });

  it("treats seasons=[] (movie) as no code ever", () => {
    expect(episodeCodeFromFileName("奥本海默 (2023).mkv", [])).toBeNull();
    expect(episodeCodeFromFileName("01.mp4", [])).toBeNull();
  });

  it("still parses SxxExx in ANY season context (self-identifying)", () => {
    expect(episodeCodeFromFileName("Show.S03E05.mkv", [1, 2])).toBe("S03E05");
    expect(episodeCodeFromFileName("Show.S01E01.mkv", [1, 2])).toBe("S01E01");
  });
});