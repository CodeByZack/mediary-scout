import { describe, expect, it } from "vitest";
import type { gradeCandidates } from "../src/acquisition-v2/candidate-grader.js";
import {
  candidateTitleEvidence,
  evidenceDigestLine,
  gradedCandidateEvidence,
  compactCodeList,
  compactMapping,
  landingParseRows,
} from "../src/consumption/fast-path/steps.js";

type Graded = ReturnType<typeof gradeCandidates>;
function fakeGrading(n: number): Graded {
  const ranked = Array.from({ length: n }, (_, i) => ({
    id: `pansou_${"deadbeef".repeat(4)}_candidate_${i}`,
    title: `超长标题${"外".repeat(120)}第${i}季`,
    grade: "B" as const,
    score: 5,
    reasons: ["判因一" + "很".repeat(60), "判因二" + "长".repeat(60), "判因三"],
    hasChineseSub: false,
    seasonNumbers: [1, 2, 3],
    quality: "1080p",
  }));
  return { ranked, uniqueTopGrade: null, top: null } as unknown as Graded;
}

describe("证据 payload 预算闸(agent-trace-sink MAX_ARGS_JSON=2000 之下)", () => {
  it("200 条超长候选仍 < 2000 JSON 字符,且保留头部若干条", () => {
    const rows = gradedCandidateEvidence(fakeGrading(200));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(200);
    expect(JSON.stringify({ candidates: rows }).length).toBeLessThan(2000);
    expect(rows[0]!.grade).toBe("B");
    expect(rows[0]!.title.length).toBeLessThanOrEqual(100);
    expect(rows[0]!.reasons.length).toBeLessThanOrEqual(2);
    expect(rows[0]!.id.startsWith("…")).toBe(true);
  });
  it("标题版证据同样受预算约束", () => {
    const rows = candidateTitleEvidence(
      Array.from({ length: 300 }, (_, i) => ({ id: `id_${"x".repeat(80)}_${i}`, title: "标".repeat(200) })),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify({ candidates: rows }).length).toBeLessThan(2000);
  });
  it("落盘解析行:400 个文件 → 预算内 + 溢出提示行", () => {
    const rows = landingParseRows(
      Array.from({ length: 400 }, (_, i) => ({ path: `/staging/${String(i).padStart(3, "0")}.mp4` })),
      [1],
    );
    expect(rows.length).toBeLessThan(400);
    expect(rows.some((row) => row.includes("⚠(裸数字,按目标季解释)"))).toBe(true);
    expect(rows[rows.length - 1]).toContain("条未列");
    expect(JSON.stringify({ files: rows }).length).toBeLessThan(2000);
  });
  it("小池不触发截断,SxxExx 文件不带 ⚠", () => {
    const rows = landingParseRows(
      [{ path: "/s/狂飙.S01E01.mkv" }, { path: "/s/狂飙.S01E02.mkv" }],
      [1],
    );
    expect(rows).toEqual(["狂飙.S01E01.mkv → S01E01", "狂飙.S01E02.mkv → S01E02"]);
  });
});

describe("evidenceDigestLine — stdout 命中摘要行", () => {
  it("前 3 条「标题[评级]」+ 24 字截断 + 溢出 ＋N", () => {
    const line = evidenceDigestLine(fakeGrading(4));
    expect((line.match(/[B]/g) ?? []).length).toBe(3);
    expect(line.endsWith("＋1")).toBe(true);
    expect(line.includes("「超长标题")).toBe(true);
    for (const m of line.matchAll(/「(.+?)」/g)) {
      expect(m[1]?.length ?? 0).toBeLessThanOrEqual(24);
    }
  });
  it("不足 3 条:全列出,不带溢出尾巴", () => {
    const line = evidenceDigestLine(fakeGrading(2));
    expect((line.match(/[B]/g) ?? []).length).toBe(2);
    expect(line.includes("＋")).toBe(false);
  });
});

describe("compactCodeList / compactMapping(issue #29 A1/A2 预算化)", () => {
  it("compactCodeList:count + 前 N 项,超长列表不整体塌缩", () => {
    const big = Array.from({ length: 200 }, (_, i) => `S02E${String(i + 1).padStart(2, "0")}`);
    const out = compactCodeList(big);
    expect(out.count).toBe(200);
    expect(out.sample.length).toBe(24);
    expect(out.sample[0]).toBe("S02E01");
    expect(JSON.stringify(out).length).toBeLessThan(2000);
  });
  it("compactMapping:超长季停预算线,追「其余 N 条未列」占位(防 trace sink _truncated 整灭)", () => {
    const mapping: Record<string, string> = {};
    for (let i = 0; i < 80; i++) mapping[`第${i + 1}话.mp4`] = `S01E${String(i + 1).padStart(2, "0")}`;
    const out = compactMapping(mapping);
    expect(out.length).toBeLessThan(80); // 未全量,停在预算线
    expect(out.at(-1)!.file).toMatch(/其余 \d+ 条未列/);
    expect(JSON.stringify(out).length).toBeLessThan(2000); // 永不过 trace sink 上限
    // 短文件名季(20 集)仍全量 ≫ 20:220 字符 < 预算
    expect(out.length).toBeGreaterThan(20);
  });
  it("compactCodeList:短列表原样全透传", () => {
    const out = compactCodeList(["S02E06"]);
    expect(out).toEqual({ count: 1, sample: ["S02E06"] });
  });
  it("compactMapping:文件名截断到 45 字符+…,条数不截(issue #29 用户拍板:AI 一次认出 20 集明细必须全量)", () => {
    const longName = "非常长的日漫粉丝字幕组文件名".repeat(20);
    const mapping: Record<string, string> = {};
    for (let i = 0; i < 16; i++) mapping[`${longName}${i}.mkv`] = `S02E${String(i + 1).padStart(2, "0")}`;
    const out = compactMapping(mapping);
    expect(out.length).toBe(16); // 全量,不截 12 条
    expect(out[0]!.file.length).toBeLessThanOrEqual(48);
    expect(out[0]!.file.endsWith("…")).toBe(true);
    expect(out.some((r) => r.code === "S02E01")).toBe(true);
    expect(JSON.stringify(out).length).toBeLessThan(2000);
  });
  it("compactMapping:短名不截断、条数少原样", () => {
    const out = compactMapping({ "01.mp4": "S02E01" });
    expect(out).toEqual([{ file: "01.mp4", code: "S02E01" }]);
  });
});
