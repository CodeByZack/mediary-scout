import { describe, expect, it } from "vitest";
import {
  gradeCandidate,
  gradeCandidates,
  seasonNumbersInTitle,
  signalsChineseSubs,
  summarizeGrading,
} from "../src/acquisition-v2/candidate-grader.js";

const tvCtx = { title: "狂飙", aliases: [], seasons: [1] };

describe("简繁折叠(normalizeForTitleMatch 末步,vendored t2s 表)", () => {
  it("繁体别名认出简体候选标题(龙之家族案)→ 不再是「标题不匹配」的 D", () => {
    const ctx = { title: "权力的游戏前传：龙族", aliases: ["龍之家族", "龍族前傳"], seasons: [1] };
    const g = gradeCandidate({ id: "1", title: "龙之家族 4K 更至10集 最新" }, ctx);
    expect(g.grade).not.toBe("D");
    // 反向同理:简体目标标题认出繁体候选。
    const g2 = gradeCandidate(
      { id: "2", title: "龍族前傳.S01E01.1080p.中字" },
      { title: "龙族前传", aliases: [], seasons: [1] },
    );
    expect(g2.grade).toBe("A");
  });

  it("折叠不放水:真正无关的候选仍判 D", () => {
    const g = gradeCandidate({ id: "1", title: "沧元图" }, { title: "龍之家族", aliases: [], seasons: [1] });
    expect(g.grade).toBe("D");
  });
});

describe("seasonNumbersInTitle", () => {
  it("parses 第N季, Sxx and Season N", () => {
    expect(seasonNumbersInTitle("狂飙 第二季")).toEqual([2]);
    expect(seasonNumbersInTitle("Breaking.Bad.S05.1080p")).toEqual([5]);
    expect(seasonNumbersInTitle("Breaking Bad Season 3 COMPLETE")).toEqual([3]);
  });

  it("returns empty for a bare title", () => {
    expect(seasonNumbersInTitle("狂飙.S01E01.1080p.中字")).toEqual([1]);
    expect(seasonNumbersInTitle("狂飙 全集")).toEqual([]);
  });
});

describe("signalsChineseSubs", () => {
  it("native-Chinese works always signal 中字", () => {
    expect(signalsChineseSubs("狂飙 1080P", true)).toBe(true);
  });

  it("explicit markers and CJK release names signal 中字", () => {
    expect(signalsChineseSubs("Show.1080p.中字", false)).toBe(true);
    expect(signalsChineseSubs("狂飙.S01E01.mkv", false)).toBe(true);
    expect(signalsChineseSubs("Show.CHS-ENG.1080p", false)).toBe(true);
  });

  it("a pure-English scene release does NOT signal 中字", () => {
    expect(signalsChineseSubs("Show.S01E01.1080p.WEB-DL.EaZy", false)).toBe(false);
  });
});

describe("gradeCandidate", () => {
  it("grades A when title + 中字 + episode evidence all line up", () => {
    const g = gradeCandidate({ id: "1", title: "狂飙.S01E01.1080p.中字" }, tvCtx);
    expect(g.grade).toBe("A");
    expect(g.hasChineseSub).toBe(true);
    expect(g.quality).toBe("1080P");
  });

  it("grades B when the title matches but no 中字 signal", () => {
    const g = gradeCandidate(
      { id: "2", title: "Show.S01E01.1080p.WEB-DL.EaZy" },
      { title: "Show", aliases: [], seasons: [1] },
    );
    expect(g.grade).toBe("B");
    expect(g.reasons.some((r) => r.includes("无中字"))).toBe(true);
  });

  it("grades C for a same-IP different work (电影版)", () => {
    const g = gradeCandidate({ id: "3", title: "狂飙 电影版 1080P" }, tvCtx);
    expect(g.grade).toBe("C");
  });

  it("grades C when the title names a season out of scope", () => {
    const g = gradeCandidate({ id: "4", title: "狂飙 第二季 全集" }, tvCtx);
    expect(g.grade).toBe("C");
    expect(g.reasons.some((r) => r.includes("季号"))).toBe(true);
  });

  it("grades D when the title does not name the target", () => {
    const g = gradeCandidate({ id: "5", title: "别的剧 S01 全集" }, tvCtx);
    expect(g.grade).toBe("D");
  });
});

describe("gradeCandidates", () => {
  it("flags a unique A-grade", () => {
    const result = gradeCandidates(
      [
        { id: "1", title: "狂飙.S01E01.1080p.中字" },
        { id: "2", title: "狂飙" },
        { id: "3", title: "别的剧" },
      ],
      tvCtx,
    );
    expect(result.uniqueTopGrade).toBe(true);
    expect(result.top?.id).toBe("1");
  });

  it("is NOT unique when two candidates both grade A", () => {
    const result = gradeCandidates(
      [
        { id: "1", title: "狂飙.S01E01.1080p.中字" },
        { id: "2", title: "狂飙.S01E02.1080p.中字" },
      ],
      tvCtx,
    );
    expect(result.uniqueTopGrade).toBe(false);
  });

  it("is NOT unique when nothing grades A (all B/C)", () => {
    const result = gradeCandidates(
      [
        { id: "1", title: "Show.S01E01.1080p.WEB-DL.EaZy" },
        { id: "2", title: "Show 电影版" },
      ],
      { title: "Show", aliases: [], seasons: [1] },
    );
    expect(result.uniqueTopGrade).toBe(false);
    expect(result.ranked[0]!.grade).toBe("B");
  });

  it("ranks A > B > C > D", () => {
    const result = gradeCandidates(
      [
        { id: "d", title: "无关" },
        { id: "b", title: "Show.S01.1080p.WEB-DL.EaZy" },
        { id: "a", title: "Show.S01E01.1080p.中字" },
        { id: "c", title: "Show 电影版" },
      ],
      { title: "Show", aliases: [], seasons: [1] },
    );
    expect(result.ranked.map((g) => g.grade)).toEqual(["A", "B", "C", "D"]);
  });
});

describe("movie mode (year identity)", () => {
  const movieCtx = { title: "流浪地球", aliases: [], seasons: [], year: 2019 };

  it("grades A when title + release year both match", () => {
    const g = gradeCandidate({ id: "1", title: "流浪地球.2019.4K.中字" }, movieCtx);
    expect(g.grade).toBe("A");
  });

  it("grades C when the release year mismatches (同名异作/remake trap)", () => {
    const g = gradeCandidate({ id: "2", title: "流浪地球.2023.4K" }, movieCtx);
    expect(g.grade).toBe("C");
    expect(g.reasons.some((r) => r.includes("年份不符"))).toBe(true);
  });

  it("grades B when the release name carries no year (identity unverifiable, never auto-killed)", () => {
    const g = gradeCandidate({ id: "3", title: "流浪地球 4K" }, movieCtx);
    expect(g.grade).toBe("B");
  });

  it("grades B when the target year is unknown (<=0) — cannot verify identity", () => {
    const g = gradeCandidate(
      { id: "4", title: "流浪地球.2019.4K" },
      { title: "流浪地球", aliases: [], seasons: [], year: 0 },
    );
    expect(g.grade).toBe("B");
  });

  it("a resolution string never reads as a year (1920x1080)", () => {
    const g = gradeCandidate({ id: "5", title: "流浪地球.1920x1080.4K" }, movieCtx);
    expect(g.grade).toBe("B"); // no year token parsed → B, not a C on year 1920
  });
});

describe("summarizeGrading", () => {
  it("emits a compact ranked summary and drops the D tail", () => {
    const result = gradeCandidates(
      [
        { id: "1", title: "狂飙.S01E01.1080p.中字" },
        { id: "2", title: "狂飙" },
        { id: "3", title: "无关剧" },
      ],
      tvCtx,
    );
    const summary = summarizeGrading(result);
    expect(summary).toContain("[A]");
    expect(summary).toContain("[B]");
    expect(summary).not.toContain("[D]");
  });

  it("carries each candidate's real id in its own bracket (the arbitrator copies [id] verbatim)", () => {
    const result = gradeCandidates(
      [
        { id: "cand_1", title: "狂飙.S01E01.1080p.中字" },
        { id: "cand_2", title: "狂飙 第二季 全集" },
      ],
      tvCtx,
    );
    const summary = summarizeGrading(result);
    expect(summary).toContain("[A] [cand_1] 狂飙.S01E01.1080p.中字");
    expect(summary).toContain("[C] [cand_2] 狂飙 第二季 全集");
  });
});
