import { describe, expect, it } from "vitest";
import {
  gradeCandidate,
  gradeCandidates,
  seasonNumbersInTitle,
  signalsChineseSubs,
  summarizeGrading,
} from "../src/acquisition-v2/candidate-grader.js";

const tvCtx = { title: "狂飙", aliases: [], seasons: [1] };

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
});
