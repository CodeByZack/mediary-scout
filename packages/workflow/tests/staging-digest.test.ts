import { describe, expect, it } from "vitest";
import { digestMovieStaging, digestStaging, digestTitle } from "../src/acquisition-v2/staging-digest.js";
import type { SimTreeFile } from "../src/acquisition-v2/storage-115-simulator.js";

function video(name: string, sizeBytes = 1_000_000_000, id = name): SimTreeFile {
  return { id, path: name, sizeBytes, isVideo: true, isSubtitle: false };
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

  it("sample 附件不再判脏:集数覆盖 need 即收尾(issue #39 用户拍板——不区分严重/轻微附件)", () => {
    // sample 命中 JUNK → 只进 junkSignals(finalize 丢弃),不否决整包;E01 覆盖 → passes=true。
    const d = digestStaging({
      files: [video("狂飙.S01E01.1080p.mkv"), video("狂飙.S01E01.sample.mkv")],
      ...tvInput,
    });
    expect(d.isDirtyPack).toBe(false);
    expect(d.passes).toBe(true);
    expect(d.junkSignals).toEqual(["狂飙.S01E01.sample.mkv"]);
    expect(d.coveredCodes).toEqual(["S01E01"]);
  });

  it("flags a dirty pack when a TV video has no episode code AND no junk marker (unknown file)", () => {
    // issue #39:无集号但命中 junk 标记(花絮/预告)→ 附件,不判脏(finalize 丢弃);
    // 只有"无集号且无 junk 标记"的未知文件(可能是正片藏集号)才判脏交 AI 映射。
    const d = digestStaging({
      files: [video("狂飙.S01E01.1080p.mkv"), video("狂飙.未识别视频.mkv")],
      ...tvInput,
    });
    expect(d.isDirtyPack).toBe(true);
    expect(d.unparsedVideos).toEqual(["狂飙.未识别视频.mkv"]);
  });

  it("issue #39: 正片齐全 + 花絮附件 → passes=true(附件丢弃、正片保留,不再整体判脏换候选)", () => {
    const d = digestStaging({
      files: [video("狂飙.S01E01.1080p.mkv"), video("狂飙.S01E02.1080p.mkv"), video("幕后花絮.mkv")],
      ...tvInput,
    });
    expect(d.passes).toBe(true);
    expect(d.isDirtyPack).toBe(false);
    expect(d.coveredCodes).toEqual(["S01E01", "S01E02"]);
    // 花絮进 junkSignals(finalize-landing 丢弃),不进 episodeCodes(防假覆盖)
    expect(d.junkSignals).toEqual(["幕后花絮.mkv"]);
    expect(d.unparsedVideos).toEqual([]);
  });

  it("issue #39: 正片 + 预告(trailer)附件 → passes=true(trailer 丢弃)", () => {
    const d = digestStaging({
      files: [video("狂飙.S01E01.1080p.mkv"), video("狂飙.预告.mkv")],
      ...tvInput,
    });
    expect(d.passes).toBe(true);
    expect(d.isDirtyPack).toBe(false);
    expect(d.junkSignals).toEqual(["狂飙.预告.mkv"]);
  });


  it("issue #39 防线:附件恰好带集号(Show.S01E01.预告.mkv)→ 不进 episodeCodes(防假覆盖→假入库)", () => {
    // 包内只有"预告"文件(命中 JUNK 标记),即使文件名带 S01E01 集号也不认作正片——
    // finalize 会丢弃它,若计入 coveredCodes 会标记已入库但文件被丢(假入库)。
    const d = digestStaging({
      files: [video("Show.S01E01.预告.mkv")],
      ...tvInput,
    });
    expect(d.episodeCodes).toEqual([]);
    expect(d.coveredCodes).toEqual([]);
    expect(d.missingCodes).toEqual(["S01E01", "S01E02", "S01E03"]);
    expect(d.passes).toBe(false);
    expect(d.junkSignals).toEqual(["Show.S01E01.预告.mkv"]);
  });

  it("issue #39 防线:AI 集数映射(overrides)也救不回附件——continue 先于 override", () => {
    // 即便 AI/overrides 给附件一个集号,digest 循环里 JUNK 命中在 parse 之前 continue,
    // 附件不进 episodeCodes(钉住关键顺序,将来有人重排循环就靠它)。
    const d = digestStaging({
      files: [video("Show.S01E01.预告.mkv")],
      overrides: { "Show.S01E01.预告.mkv": "S01E01" },
      ...tvInput,
    });
    expect(d.episodeCodes).toEqual([]);
    expect(d.coveredCodes).toEqual([]);
    expect(d.passes).toBe(false);
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

  it("movie sample 文件:dominant 判据把 sample 当附件丢(奥本海默 1GB > sample 100MB×2)", () => {
    // movie 走 digestMovieStaging(PR #37):sample 命中 JUNK → dominant 判据的"其余全是脏包"成立，
    // 1GB 主片 > 100MB sample×2 → 代码直收(保留主片、丢弃 sample)。
    const d = digestMovieStaging([video("奥本海默 (2023).mkv"), video("奥本海默 sample.mkv", 100_000_000)]);
    expect(d.dominant?.id).toBe("奥本海默 (2023).mkv");
    expect(d.dominant?.dropped).toEqual([{ name: "奥本海默 sample.mkv", bytes: 100_000_000 }]);
    expect(d.junkSignals).toEqual(["奥本海默 sample.mkv"]);
  });
});

describe("digestMovieStaging — the movie fast path's one-film judgment", () => {
  it("passes exactly one clean video (subtitles ride along, never junk)", () => {
    const d = digestMovieStaging([video("流浪地球.2019.4K.mkv"), sub("流浪地球.zh.ass")]);
    expect(d.passes).toBe(true);
    expect(d.isDirtyPack).toBe(false);
    expect(d.videos).toHaveLength(1);
    // 单视频是干净直收,不该判定为 dominant 包(防"单视频也置位"回归)
    expect(d.dominant).toBe(null);
  });

  it("dirty when ≥2 videos land (collection / film+trailer bundle)", () => {
    const d = digestMovieStaging([video("a.mkv"), video("b.mkv")]);
    expect(d.passes).toBe(false);
    expect(d.isDirtyPack).toBe(true);
  });

  it("dirty when any video carries a junk signal (预告/花絮/sample)", () => {
    // 大小相同(默认 1GB each) → 主片 1GB 不 > 1GB×2 → 不满足判据 → 交 AI(dirty)
    const d = digestMovieStaging([video("流浪地球.2019.4K.mkv"), video("流浪地球.预告.mkv")]);
    expect(d.passes).toBe(false);
    expect(d.isDirtyPack).toBe(true);
    expect(d.junkSignals).toEqual(["流浪地球.预告.mkv"]);
    expect(d.dominant).toBe(null);
  });
  it("code-accepts when one video is clearly dominant and others are all junk", () => {
    // 主片 3GB，trailer 200MB，花絮 100MB → 主片 > 其余和×2 且均 ≥300MB/≤1.5GB → 代码直收
    const files: SimTreeFile[] = [
      { id: "main", path: "Oppenheimer.2023.4K.mkv", sizeBytes: 3_000_000_000, isVideo: true, isSubtitle: false },
      { id: "trailer", path: "Oppenheimer.trailer.mp4", sizeBytes: 200_000_000, isVideo: true, isSubtitle: false },
      { id: "extra", path: "Oppenheimer.花絮.mkv", sizeBytes: 100_000_000, isVideo: true, isSubtitle: false },
    ];
    const d = digestMovieStaging(files);
    expect(d.passes).toBe(false);
    expect(d.isDirtyPack).toBe(true);
    expect(d.junkSignals).toEqual(["Oppenheimer.trailer.mp4", "Oppenheimer.花絮.mkv"]);
    expect(d.dominant?.id).toBe("main");
    expect(d.dominant?.keptName).toBe("Oppenheimer.2023.4K.mkv");
    // dropped 名单 = 可变回溯的完整证据(名字+体积)
    expect(d.dominant?.dropped).toEqual([
      { name: "Oppenheimer.trailer.mp4", bytes: 200_000_000 },
      { name: "Oppenheimer.花絮.mkv", bytes: 100_000_000 },
    ]);
  });
  it("does not accept when non-junk video breaks the pattern", () => {
    // 主片 3GB + trailer 200MB + 另一个正片 2GB → 第二个非脏包视频 → 不可代码接受,交 AI
    const files: SimTreeFile[] = [
      { id: "main", path: "Oppenheimer.2023.4K.mkv", sizeBytes: 3_000_000_000, isVideo: true, isSubtitle: false },
      { id: "trailer", path: "Oppenheimer.trailer.mp4", sizeBytes: 200_000_000, isVideo: true, isSubtitle: false },
      { id: "other", path: "Oppenheimer.Part2.mkv", sizeBytes: 2_000_000_000, isVideo: true, isSubtitle: false },
    ];
    const d = digestMovieStaging(files);
    expect(d.dominant).toBe(null);
  });
  it("does not accept when the largest video itself carries a junk signal", () => {
    // 最大件是"花絮"(脏包标记),不可能是正片 → 交 AI
    const files: SimTreeFile[] = [
      { id: "main", path: "Oppenheimer.2023.4K.花絮.mkv", sizeBytes: 3_000_000_000, isVideo: true, isSubtitle: false },
      { id: "trailer", path: "Oppenheimer.trailer.mp4", sizeBytes: 200_000_000, isVideo: true, isSubtitle: false },
    ];
    const d = digestMovieStaging(files);
    expect(d.dominant).toBe(null);
  });
  it("does not accept at exactly 2x (strict >)", () => {
    // 主片恰为其余 2 倍 → 严格大于不满足 → 交 AI(保守)
    const files: SimTreeFile[] = [
      { id: "main", path: "Oppenheimer.2023.4K.mkv", sizeBytes: 400_000_000, isVideo: true, isSubtitle: false },
      { id: "trailer", path: "Oppenheimer.trailer.mp4", sizeBytes: 200_000_000, isVideo: true, isSubtitle: false },
    ];
    const d = digestMovieStaging(files);
    expect(d.dominant).toBe(null);
  });
  it("does not accept when sizes are all zero (no evidence)", () => {
    const files: SimTreeFile[] = [
      { id: "main", path: "Oppenheimer.2023.4K.mkv", sizeBytes: 0, isVideo: true, isSubtitle: false },
      { id: "trailer", path: "Oppenheimer.trailer.mp4", sizeBytes: 0, isVideo: true, isSubtitle: false },
    ];
    const d = digestMovieStaging(files);
    expect(d.dominant).toBe(null);
  });
  it("does not accept when the main video is below the absolute floor", () => {
    // 主片 500MB 达标,但需 ≥300MB;这里 150MB 正片 + 50MB 花絮 → 主片低于下限 → 交 AI
    // (防误命名的短片/预告被当正片代码假入库)
    const files: SimTreeFile[] = [
      { id: "main", path: "Movie.2023.4K.mp4", sizeBytes: 150_000_000, isVideo: true, isSubtitle: false },
      { id: "extra", path: "Movie.2023.花絮.mp4", sizeBytes: 50_000_000, isVideo: true, isSubtitle: false },
    ];
    const d = digestMovieStaging(files);
    expect(d.dominant).toBe(null);
  });
  it("does not accept an oversized junk file (2GB trailer would be silently deleted)", () => {
    // 其余件 2GB > junkMax 1.5GB → 不直收,防"2GB 的 trailer"被代码删掉
    const files: SimTreeFile[] = [
      { id: "main", path: "Oppenheimer.2023.4K.mkv", sizeBytes: 8_000_000_000, isVideo: true, isSubtitle: false },
      { id: "trailer", path: "Oppenheimer.trailer.mp4", sizeBytes: 2_000_000_000, isVideo: true, isSubtitle: false },
    ];
    const d = digestMovieStaging(files);
    expect(d.dominant).toBe(null);
  });

  it("neither passes nor dirty when nothing lands as a video (subtitle-only)", () => {
    const d = digestMovieStaging([sub("流浪地球.zh.ass")]);
    expect(d.passes).toBe(false);
    expect(d.isDirtyPack).toBe(false);
    expect(d.videos).toHaveLength(0);
    expect(d.dominant).toBe(null);
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
