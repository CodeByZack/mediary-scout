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
