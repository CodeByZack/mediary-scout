import { describe, expect, it } from "vitest";
import type { ActivityStepView } from "./activity-view";
import { stepArgsText } from "./step-args-text";

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