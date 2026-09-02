import { describe, expect, it } from "vitest";
import type { ActivityStepView } from "./activity-view";
import { stepArgsText, stepDetailView } from "./step-args-text";

const step = (args: Record<string, unknown>): ActivityStepView =>
  ({ args } as unknown) as ActivityStepView;

describe("stepArgsText — 活动页 args 一行摘要", () => {
  it("旧合同不变:renames/moves/codes/keyword/fileIds/_truncated", () => {
    expect(stepArgsText(step({ renames: [{ newName: "A.mkv" }, { newName: "B.mkv" }, { newName: "C.mkv" }, { newName: "D.mkv" }] }))).toBe("改名 A.mkv、B.mkv、C.mkv 等 4 个");
    expect(stepArgsText(step({ moves: [{ season: 2 }, {}] }))).toBe("分发到 第 2 季、影片目录");
    expect(stepArgsText(step({ codes: ["S01E01", "S01E02"] }))).toBe("已标记 2 集");
    expect(stepArgsText(step({ keyword: "Outer Banks" }))).toBe("关键词: Outer Banks");
    expect(stepArgsText(step({ fileIds: ["a", "b", "c"] }))).toBe("3 个文件");
    expect(stepArgsText(step({ _truncated: true }))).toBe("参数过长已省略");
    expect(stepArgsText(step({}))).toBeNull();
    expect(stepArgsText(step({ candidateId: "c1" }))).toBeNull();
  });
  it("L2/L3 证据:candidates/pool 前 3 条「标题[评级]」+ 等 N 条", () => {
    const candidates = [
      { id: "c1", title: "星际迷航奇异新世界3.全集", grade: "A" },
      { id: "c2", title: "Star.Trek.DSC.S03.2160p", grade: "B" },
      { id: "c3", title: "某超长标题" + "字".repeat(60), grade: "B" },
      { id: "c4", title: "第四条", grade: "D" },
    ];
    const text = stepArgsText(step({ candidates }));
    // 标题截 24 字:「某超长标题」5 字 + 字×19
    expect(text).toBe(
      "证据: 「星际迷航奇异新世界3.全集」[A]、「Star.Trek.DSC.S03.2160p」[B]、「某超长标题" +
      "字".repeat(19) +
      "」[B] 等 4 条",
    );
    expect(stepArgsText(step({ pool: [{ id: "c9", title: "唯一一条" }], reasoning: "r" }))).toBe("证据: 「唯一一条」");
  });
  it("兜底评分事件:keyword 与 candidates 共存时带词前缀", () => {
    const text = stepArgsText(step({ keyword: "The Knockout", candidates: [{ id: "c1", title: "狂飙 S01", grade: "A" }] }));
    expect(text).toBe("词「The Knockout」· 证据: 「狂飙 S01」[A]");
  });
  it("L4 files:前 2 行解析原文", () => {
    const text = stepArgsText(step({ files: ["01.mp4 → S01E01 ⚠(裸数字,按目标季解释)", "02.mp4 → S01E02 ⚠(裸数字,按目标季解释)", "03.mp4 → S01E03 ⚠(裸数字,按目标季解释)"] }));
    expect(text).toBe("解析: 01.mp4 → S01E01 ⚠(裸数字,按目标季解释) ｜ 02.mp4 → S01E02 ⚠(裸数字,按目标季解释)");
  });
});

describe("stepDetailView — 结构化证据行(§23)", () => {
  it("candidates 全量行:标题/评级/链接/keyword,不截条(判因不上 UI)", () => {
    const d = stepDetailView(
      step({
        keyword: "龍之家族",
        candidates: [
          { id: "a", title: "龙之家族 4K 更至10集 最新", grade: "D", url: "https://pan.example/s/abc" },
          { id: "b", title: "沧元图", grade: "D" },
        ],
      }),
    );
    if (d === null || d.kind !== "candidates") throw new Error("期望 candidates 视图");
    expect(d.keyword).toBe("龍之家族");
    expect(d.rows.length).toBe(2);
    expect(d.rows[0]).toEqual({
      title: "龙之家族 4K 更至10集 最新",
      grade: "D",
      url: "https://pan.example/s/abc",
    });
    // 无 url 的候选不带 url 字段(exactOptionalPropertyTypes)。
    expect(d.rows[1]).toEqual({ title: "沧元图", grade: "D" });
  });

  it("files 行直出;_truncated/无关 args → null(组件回退一行摘要)", () => {
    expect(stepDetailView(step({ files: ["01.mp4 → S01E01", "x.mkv → 解析失败"] }))).toEqual({
      kind: "files",
      rows: ["01.mp4 → S01E01", "x.mkv → 解析失败"],
    });
    expect(stepDetailView(step({ _truncated: true, candidates: [{ title: "x" }] }))).toBeNull();
    expect(stepDetailView(step({ renames: [{ newName: "A.mkv" }] }))).toBeNull();
    expect(stepDetailView(step({}))).toBeNull();
  });

  it("AI 集数映射(mapping)逐条分行——扩 files 行渲染,不再挤一行", () => {
    expect(stepDetailView(step({ mapping: [
      { file: "01.mkv", code: "S01E01" },
      { file: "02.mkv", code: "S01E02" },
    ] }))).toEqual({
      kind: "files",
      rows: ["01.mkv → S01E01", "02.mkv → S01E02"],
    });
    expect(stepDetailView(step({ mapping: [] }))).toBeNull();
  });
});
describe("B6(issue #29)紧凑集号/AI 映射消费", () => {
  function st(args: Record<string, unknown>): ActivityStepView {
    return { ordinal: 1, toolName: "stagingDigest", activity: "a", phase: "verify", at: "2026-09-01T00:00:00Z", args, stepStatus: "success" };
  }
  it("missingCodes {count,sample} → '还缺 N 集'(issue #29 九轮:只报数量,不罗列样本——明细在同卡 files)", () => {
    const out = stepArgsText(st({ coveredCodes: { count: 1, sample: ["S02E06"] }, missingCodes: { count: 2, sample: ["S02E19", "S02E20"] } }));
    expect(out).toBe("还缺 2 集 · 已有 1 集");
    expect(out).not.toContain("S02E19");
  });
  it("coveredCodes {count:0} → null(无遗漏,不显示)", () => {
    expect(stepArgsText(st({ coveredCodes: { count: 0, sample: [] }, missingCodes: { count: 0, sample: [] } }))).toBeNull();
  });
  it("mapping compact → 'AI 映射: file → code'", () => {
    const out = stepArgsText(st({ aiUsed: true, mapping: [{ file: "01.mp4", code: "S02E19" }] }));
    expect(out).toContain("AI 映射");
    expect(out).toContain("S02E19");
  });
  it("老形状数组 coveredCodes 兼容", () => {
    const out = stepArgsText(st({ coveredCodes: ["S02E06"], missingCodes: [] }));
    expect(out).toContain("命中 1 集");
  });
});
