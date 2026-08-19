import { describe, expect, it } from "vitest";
import { digestMovieStaging, digestStaging } from "../src/acquisition-v2/staging-digest.js";
import type { SimTreeFile } from "../src/acquisition-v2/storage-115-simulator.js";

function video(name: string, id = name): SimTreeFile {
  return { id, path: name, sizeBytes: 1_000_000_000, isVideo: true, isSubtitle: false };
}
function sub(name: string, id = name): SimTreeFile {
  return { id, path: name, sizeBytes: 1_000_000, isVideo: false, isSubtitle: true };
}

const tvInput = { seasons: [1], needCodes: ["S01E01", "S01E02", "S01E03"] };

describe("digestStaging — TV", () => {
  it("passes a clean landing that covers the need", () => {
    const d = digestStaging({
      files: [video("狂飙.S01E01.1080p.mkv"), video("狂飙.S01E02.1080p.mkv"), sub("狂飙.S01E01.zh.ass")],
      ...tvInput,
    });
    expect(d.passes).toBe(true);
    expect(d.isDirtyPack).toBe(false);
    expect(d.episodeCodes).toEqual(["S01E01", "S01E02"]);
    expect(d.coveredCodes).toEqual(["S01E01", "S01E02"]);
    expect(d.missingCodes).toEqual(["S01E03"]);
    expect(d.subtitles).toHaveLength(1);
  });

  it("flags a dirty pack when a sample file lands", () => {
    const d = digestStaging({
      files: [video("狂飙.S01E01.1080p.mkv"), video("狂飙.S01E01.sample.mkv")],
      ...tvInput,
    });
    expect(d.isDirtyPack).toBe(true);
    expect(d.passes).toBe(false);
    expect(d.junkSignals.length).toBeGreaterThan(0);
  });

  it("flags a dirty pack when a TV video has no episode code", () => {
    const d = digestStaging({
      files: [video("狂飙.S01E01.1080p.mkv"), video("幕后花絮.mkv")],
      ...tvInput,
    });
    expect(d.isDirtyPack).toBe(true);
    expect(d.unparsedVideos).toEqual(["幕后花絮.mkv"]);
  });

  it("reports out-of-season codes without failing coverage of in-season ones", () => {
    const d = digestStaging({
      files: [video("狂飙.S02E01.1080p.mkv"), video("狂飙.S01E01.1080p.mkv")],
      ...tvInput,
    });
    expect(d.outOfSeasonCodes).toEqual(["S02E01"]);
    expect(d.coveredCodes).toEqual(["S01E01"]);
    expect(d.passes).toBe(true);
  });

  it("does not pass when nothing covers the need", () => {
    const d = digestStaging({
      files: [video("狂飙.S03E01.1080p.mkv")],
      ...tvInput,
    });
    expect(d.coveredCodes).toEqual([]);
    expect(d.passes).toBe(false);
    expect(d.isDirtyPack).toBe(false);
  });
});

describe("digestStaging — movie", () => {
  it("passes a clean film landing (no episode code is NOT junk for a movie)", () => {
    const d = digestStaging({
      files: [video("奥本海默 (2023).mkv"), sub("奥本海默 (2023).zh.ass")],
      seasons: [],
      needCodes: ["MOVIE"],
    });
    expect(d.passes).toBe(true);
    expect(d.isDirtyPack).toBe(false);
    expect(d.unparsedVideos).toHaveLength(1); // the film itself
    expect(d.episodeCodes).toEqual([]);
  });

  it("flags junk even for a movie (sample file)", () => {
    const d = digestStaging({
      files: [video("奥本海默 (2023).mkv"), video("奥本海默 sample.mkv")],
      seasons: [],
      needCodes: ["MOVIE"],
    });
    expect(d.isDirtyPack).toBe(true);
  });
});

describe("digestMovieStaging — the movie fast path's one-film judgment", () => {
  it("passes exactly one clean video (subtitles ride along, never junk)", () => {
    const d = digestMovieStaging([video("流浪地球.2019.4K.mkv"), sub("流浪地球.zh.ass")]);
    expect(d.passes).toBe(true);
    expect(d.isDirtyPack).toBe(false);
    expect(d.videos).toHaveLength(1);
  });

  it("dirty when ≥2 videos land (collection / film+trailer bundle)", () => {
    const d = digestMovieStaging([video("a.mkv"), video("b.mkv")]);
    expect(d.passes).toBe(false);
    expect(d.isDirtyPack).toBe(true);
  });

  it("dirty when any video carries a junk signal (预告/花絮/sample)", () => {
    const d = digestMovieStaging([video("流浪地球.2019.4K.mkv"), video("流浪地球.预告.mkv")]);
    expect(d.passes).toBe(false);
    expect(d.isDirtyPack).toBe(true);
    expect(d.junkSignals).toEqual(["流浪地球.预告.mkv"]);
  });

  it("neither passes nor dirty when nothing lands as a video (subtitle-only)", () => {
    const d = digestMovieStaging([sub("流浪地球.zh.ass")]);
    expect(d.passes).toBe(false);
    expect(d.isDirtyPack).toBe(false);
    expect(d.videos).toHaveLength(0);
  });
});
