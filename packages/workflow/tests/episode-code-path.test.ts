import { describe, expect, it } from "vitest";
import { episodeCodeFromPath, seasonFromPathSegments } from "../src/episode-code.js";

describe("episodeCodeFromPath — issue #53 全路径归季", () => {
  // ─────────────────────────────────────────────────────────────────────
  // A1. 路径季号扫描（多季场景，seasons = [1, 2, 3]）
  // ─────────────────────────────────────────────────────────────────────
  describe("A1: 路径季号扫描（多季，seasons=[1,2,3]）", () => {
    it("Season N 模式", () => {
      expect(episodeCodeFromPath("Show/Season 1/01.mkv", [1, 2, 3])).toEqual({ code: "S01E01", seasonSource: "path" });
    });

    it("0-padding: Season 01", () => {
      expect(episodeCodeFromPath("Show/Season 01/02.mkv", [1, 2, 3])).toEqual({ code: "S01E02", seasonSource: "path" });
    });

    it("S0N 模式", () => {
      expect(episodeCodeFromPath("Show/S01/03.mkv", [1, 2, 3])).toEqual({ code: "S01E03", seasonSource: "path" });
    });

    it("S N 模式（带空格）", () => {
      expect(episodeCodeFromPath("Show/S 1/04.mkv", [1, 2, 3])).toEqual({ code: "S01E04", seasonSource: "path" });
    });

    it("SN 模式（无 padding）", () => {
      expect(episodeCodeFromPath("Show/S1/05.mkv", [1, 2, 3])).toEqual({ code: "S01E05", seasonSource: "path" });
    });

    it("第N季 模式", () => {
      expect(episodeCodeFromPath("Show/第1季/06.mkv", [1, 2, 3])).toEqual({ code: "S01E06", seasonSource: "path" });
    });

    it("N季 模式", () => {
      expect(episodeCodeFromPath("Show/1季/07.mkv", [1, 2, 3])).toEqual({ code: "S01E07", seasonSource: "path" });
    });

    it("N 季 模式（带空格）", () => {
      expect(episodeCodeFromPath("Show/1 季/08.mkv", [1, 2, 3])).toEqual({ code: "S01E08", seasonSource: "path" });
    });

    it("中文数字：第一季", () => {
      expect(episodeCodeFromPath("Show/第一季/09.mkv", [1, 2, 3])).toEqual({ code: "S01E09", seasonSource: "path" });
    });

    it("纯数字 segment（1 在 seasonNumbers 中）", () => {
      expect(episodeCodeFromPath("Show/1/10.mkv", [1, 2, 3])).toEqual({ code: "S01E10", seasonSource: "path" });
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // A2. 排除模式（多季场景）
  // ─────────────────────────────────────────────────────────────────────
  describe("A2: 排除模式（多季）", () => {
    it("年份不采信", () => {
      expect(episodeCodeFromPath("Show/2020/01.mkv", [1, 2, 3])).toEqual({ code: null, seasonSource: null });
    });

    it("分辨率不采信", () => {
      expect(episodeCodeFromPath("Show/1080p/01.mkv", [1, 2, 3])).toEqual({ code: null, seasonSource: null });
    });

    it("纯数字不在 seasonNumbers 中", () => {
      expect(episodeCodeFromPath("Show/5/01.mkv", [1, 2, 3])).toEqual({ code: null, seasonSource: null });
    });

    it("无季号信息（早期/后期等）", () => {
      expect(episodeCodeFromPath("Show/早期/01.mkv", [1, 2, 3])).toEqual({ code: null, seasonSource: null });
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // A3. SxxExx 优先级（多季场景）
  // ─────────────────────────────────────────────────────────────────────
  describe("A3: basename SxxExx 优先（多季）", () => {
    it("basename SxxExx 优先于路径季号", () => {
      expect(episodeCodeFromPath("Show/Season 1/Show.S03E01.mkv", [1, 2, 3])).toEqual({ code: "S03E01", seasonSource: "basename" });
    });

    it("路径归季（basename 无 SxxExx）", () => {
      expect(episodeCodeFromPath("Show/Season 1/01.mkv", [1, 2, 3])).toEqual({ code: "S01E01", seasonSource: "path" });
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // A4. 多 segment 扫描（多季场景）
  // ─────────────────────────────────────────────────────────────────────
  describe("A4: 多 segment 扫描（多季）", () => {
    it("深层嵌套路径", () => {
      expect(episodeCodeFromPath("[Group] Show/Season 1/Episodes/01.mkv", [1, 2, 3])).toEqual({ code: "S01E01", seasonSource: "path" });
    });

    it("无季号的深层路径", () => {
      expect(episodeCodeFromPath("[Group] Show/早期/01.mkv", [1, 2, 3])).toEqual({ code: null, seasonSource: null });
    });

    it("首个命中即返回", () => {
      expect(episodeCodeFromPath("Show/Season 1/Season 2/01.mkv", [1, 2, 3])).toEqual({ code: "S01E01", seasonSource: "path" });
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // A5. 单季退化（seasons = [3]）— KEY REGRESSION
  // ─────────────────────────────────────────────────────────────────────
  describe("A5: 单季退化（seasons=[3]）— 关键回归", () => {
    it("裸数字按目标季解析", () => {
      expect(episodeCodeFromPath("01.mkv", [3])).toEqual({ code: "S03E01", seasonSource: "basename" });
    });

    it("带文件夹的裸数字按目标季解析", () => {
      expect(episodeCodeFromPath("Show/01.mkv", [3])).toEqual({ code: "S03E01", seasonSource: "basename" });
    });

    it("单季不走路径扫描：任务季优先于文件夹季", () => {
      expect(episodeCodeFromPath("Show/Season 1/01.mkv", [3])).toEqual({ code: "S03E01", seasonSource: "basename" });
    });

    it("basename SxxExx 优先（单季也认）", () => {
      expect(episodeCodeFromPath("Show/Season 1/Show.S01E01.mkv", [3])).toEqual({ code: "S01E01", seasonSource: "basename" });
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // F. cross 规则回归
  // ─────────────────────────────────────────────────────────────────────
  describe("F: cross 规则回归（issue #53 附带修）", () => {
    it("F1: 1×01 多季场景可解析", () => {
      // cross 规则自带季号，多季场景也启用
      expect(episodeCodeFromPath("Show.1x01.mkv", [1, 2], undefined)).toEqual({ code: "S01E01", seasonSource: "basename" });
      // 注意：episodeCodeFromPath 接收完整路径，这里 basename 即完整路径
      expect(episodeCodeFromPath("Show.1x01.mkv", [1, 2])).toEqual({ code: "S01E01", seasonSource: "basename" });
    });

    it("F2: 1080x576 不误判", () => {
      expect(episodeCodeFromPath("Show.1080x576.01.mkv", [1, 2])).toEqual({ code: null, seasonSource: null });
    });

    it("F2b: 1x1080 集号为分辨率时不采信", () => {
      // isPlausibleEpisodeNumber 排除 1080
      expect(episodeCodeFromPath("Show.1x1080.mkv", [1, 2])).toEqual({ code: null, seasonSource: null });
    });
  });
});

describe("seasonFromPathSegments — 路径 segment 季号提取", () => {
  it("Season N / S0N / S N / SN", () => {
    expect(seasonFromPathSegments("Show/Season 1/01.mkv", [1, 2, 3])).toBe(1);
    expect(seasonFromPathSegments("Show/S02/01.mkv", [1, 2, 3])).toBe(2);
    expect(seasonFromPathSegments("Show/S 3/01.mkv", [1, 2, 3])).toBe(3);
    expect(seasonFromPathSegments("Show/S3/01.mkv", [1, 2, 3])).toBe(3);
  });

  it("第N季 / N季 / N 季 / 中文数字", () => {
    expect(seasonFromPathSegments("Show/第2季/01.mkv", [1, 2, 3])).toBe(2);
    expect(seasonFromPathSegments("Show/3季/01.mkv", [1, 2, 3])).toBe(3);
    expect(seasonFromPathSegments("Show/2 季/01.mkv", [1, 2, 3])).toBe(2);
    expect(seasonFromPathSegments("Show/第二季/01.mkv", [1, 2, 3])).toBe(2);
  });

  it("纯数字 segment（在 seasonNumbers 中）", () => {
    expect(seasonFromPathSegments("Show/1/01.mkv", [1, 2, 3])).toBe(1);
    expect(seasonFromPathSegments("Show/2/01.mkv", [1, 2, 3])).toBe(2);
  });

  it("排除年份/分辨率", () => {
    expect(seasonFromPathSegments("Show/2020/01.mkv", [1, 2, 3])).toBeNull();
    expect(seasonFromPathSegments("Show/1080/01.mkv", [1, 2, 3])).toBeNull();
    expect(seasonFromPathSegments("Show/2160/01.mkv", [1, 2, 3])).toBeNull();
  });

  it("纯数字不在 seasonNumbers 中 → null", () => {
    expect(seasonFromPathSegments("Show/5/01.mkv", [1, 2, 3])).toBeNull();
  });

  it("无季号信息 → null", () => {
    expect(seasonFromPathSegments("Show/早期/01.mkv", [1, 2, 3])).toBeNull();
  });

  it("多 segment 首个命中", () => {
    expect(seasonFromPathSegments("Show/Season 1/Season 2/01.mkv", [1, 2, 3])).toBe(1);
  });

  it("只扫目录 segment（不含文件名）", () => {
    expect(seasonFromPathSegments("Show/1/01.mkv", [1, 2, 3])).toBe(1);
    expect(seasonFromPathSegments("01.mkv", [1, 2, 3])).toBeNull(); // 无目录 segment
  });
});
