import { describe, expect, it } from "vitest";
import { digestMovieStaging, digestStaging, digestTitle } from "../src/acquisition-v2/staging-digest.js";
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
describe("digestStaging — overrides (功能2 AI 集数映射)", () => {
  it("parses a pure-numeric landing through overrides (code cannot)", () => {
    const d = digestStaging({
      files: [video("01.mp4"), video("02.mp4")],
      seasons: [1],
      needCodes: ["S01E01", "S01E02"],
      overrides: { "01.mp4": "S01E01", "02.mp4": "S01E02" },
    });
    expect(d.passes).toBe(true);
    expect(d.episodeCodes).toEqual(["S01E01", "S01E02"]);
    expect(d.coveredCodes).toEqual(["S01E01", "S01E02"]);
    expect(d.unparsedVideos).toEqual([]);
  });

  it("keeps unknown files unparsed when overrides do not cover them", () => {
    const d = digestStaging({
      files: [video("01.mp4"), video("x.mkv")],
      seasons: [1],
      needCodes: ["S01E01"],
      overrides: { "01.mp4": "S01E01" },
    });
    expect(d.episodeCodes).toEqual(["S01E01"]);
    expect(d.unparsedVideos).toEqual(["x.mkv"]);
    expect(d.isDirtyPack).toBe(true);
  });

  it("ignores overrides for files that do not exist in the landing (anti-hallucination)", () => {
    const d = digestStaging({
      files: [video("01.mp4")],
      seasons: [1],
      needCodes: ["S01E01", "S01E02"],
      overrides: { "01.mp4": "S01E01", "幻觉文件.mp4": "S01E02" },
    });
    // 幻觉文件名不进 episodeCodes(文件不存在,digest 只认真实文件)
    expect(d.episodeCodes).toEqual(["S01E01"]);
    expect(d.coveredCodes).toEqual(["S01E01"]);
    expect(d.missingCodes).toEqual(["S01E02"]);
  });
});
describe("digestStaging — 综艺「第N期」Part 锚定(2026-08-31 地球超新鲜案)", () => {
  const episodeNames = {
    S01E01: "Episode 1 (Part 1)",
    S01E02: "Episode 1 (Part 2)",
    S01E19: "Episode 10 (Part 1)",
    S01E20: "Episode 10 (Part 2)",
  } as Record<string, string>;

  it("第10期上→S01E19、第10期下→S01E20(每期拆两集的综艺,机械 E(N) 会错位)", () => {
    const d = digestStaging({
      seasons: [1],
      needCodes: ["S01E19"],
      episodeNames,
      files: [
        video("2026.08.28_第10期上_4K.mp4"),
        video("2026.08.29_第10期下_4K.mp4"),
      ],
    });
    expect(d.episodeCodes).toEqual(["S01E19", "S01E20"]);
    expect(d.coveredCodes).toEqual(["S01E19"]);
  });

  it("无 episodeNames(未配 TMDB 元数据)时回退机械 E(N):第10期→S01E10(旧语义)", () => {
    const d = digestStaging({
      seasons: [1],
      needCodes: ["S01E10"],
      files: [video("2026.08.28_第10期_4K.mp4")],
    });
    expect(d.episodeCodes).toEqual(["S01E10"]);
  });

  it("有 episodeNames 但该期不在表内 → 回退机械 E(N)(不退化全包 unparsed)", () => {
    const d = digestStaging({
      seasons: [1],
      needCodes: ["S01E11"],
      episodeNames,
      files: [video("2026.09.05_第11期_4K.mp4")],
    });
    expect(d.episodeCodes).toEqual(["S01E11"]);
  });

  it("第N期无上/下标记且该期多 part → 取 Part 1(正片主体)", () => {
    const d = digestStaging({
      seasons: [1],
      needCodes: ["S01E19"],
      episodeNames,
      files: [video("2026.08.28_第10期_4K.mp4")],
    });
    expect(d.episodeCodes).toEqual(["S01E19"]);
  });

  it("第N期被衍生黑名单挡掉(彩蛋/加更)不参与 Part 锚定", () => {
    const d = digestStaging({
      seasons: [1],
      needCodes: ["S01E19"],
      episodeNames,
      files: [video("2026.08.28_第10期彩蛋_4K.mp4")],
    });
    // 彩蛋不该有集号
    expect(d.episodeCodes).toEqual([]);
    expect(d.unparsedVideos.length).toBe(1);
  });


describe("digestTitle — 活动页标题计数化(issue #29 用户拍板)", () => {
  it("覆盖全部缺集时:代码识别出 N 集,目标集数已齐", () => {
    const d = digestStaging({
      files: [video("狂飙.S01E01.mkv"), video("狂飙.S01E02.mkv"), video("狂飙.S01E03.mkv")],
      ...tvInput,
    });
    expect(digestTitle(d)).toBe("代码识别出 3 集,目标集数已齐");
  });

  it("部分覆盖:代码识别出 N 集,还有 M 集没认出来(不罗列集号长串)", () => {
    const d = digestStaging({
      files: [video("狂飙.S01E01.mkv"), video("S01E01.mkv路径外视频.mkv")],
      seasons: [1],
      needCodes: ["S01E01", "S01E02", "S01E03"],
    });
    expect(digestTitle(d)).toContain("代码识别出 1 集");
    expect(digestTitle(d)).toContain("还有 2 集没认出来");
    expect(digestTitle(d)).not.toContain("S01E02"); // 计数化,不罗列
  });

  it("零覆盖:代码识别出 0 集 + 看不出集数的文件数", () => {
    const d = digestStaging({
      files: [video("20250803-无规则数字.mkv")],
      seasons: [1],
      needCodes: ["S01E01"],
    });
    expect(digestTitle(d)).toContain("代码识别出 0 集");
    expect(digestTitle(d)).toContain("1 个文件看不出集数");
  });
});
});
