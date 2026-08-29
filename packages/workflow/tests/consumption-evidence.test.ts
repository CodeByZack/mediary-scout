import { describe, expect, it } from "vitest";
import type { gradeCandidates } from "../src/acquisition-v2/candidate-grader.js";
import {
  candidateTitleEvidence,
  gradedCandidateEvidence,
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