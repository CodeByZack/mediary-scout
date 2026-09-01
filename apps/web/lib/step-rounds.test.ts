import { describe, expect, it } from "vitest";
import type { ActivityStepView } from "./activity-view";
import { decidedByLabel, groupStepsIntoRounds, poolLabel } from "./step-rounds";

function step(
  toolName: string,
  activity: string,
  args: Record<string, unknown> = {},
  ordinal = 1,
): ActivityStepView {
  return { ordinal, toolName, activity, phase: "search", at: "2026-09-01T00:00:00Z", args, stepStatus: "success" };
}

describe("groupStepsIntoRounds", () => {
  it("把带 round 的转存链路分组为轮次卡片,决策链在最前", () => {
    const steps: ActivityStepView[] = [
      step("viewResourceSnapshot", "候选 94 条"),
      step("gradeCandidates", "A 14 / B 80 / C 0 / D 0"),
      step("pickCandidate", "primary池唯一 A 盲转:候选 cX", { decidedBy: "code" }),
      step("transferCandidate", "primary池候选 cX(1/3 次转存)", { candidateId: "cX", round: 1, pool: "primary", decidedBy: "code", transferIndex: 1 }),
      step("stagingDigest", "未通过(脏包):…", { round: 1, passes: false, videoCount: 31, coveredCodes: ["S02E06"], missingCodes: ["S02E19"] }),
      step("digestFiles", "逐文件解析 31 条", { files: ["a.mp4 → S02E06"] }),
      step("arbitrateDiagnosis", "off-target 重试:换候选 cY", {}),
      step("transferCandidate", "primary池候选 cY(2/3 次转存)", { candidateId: "cY", round: 2, pool: "primary", decidedBy: "ai", transferIndex: 2 }),
      step("stagingDigest", "干净落地,覆盖 S02E19", { round: 2, passes: true, videoCount: 4, coveredCodes: ["S02E19"], missingCodes: [] }),
    ];
    const cards = groupStepsIntoRounds(steps);
    expect(cards.length).toBe(3);
    expect(cards[0]?.round).toBe(0);
    expect(cards[0]?.heading).toContain("决策链");
    expect(cards[0]?.steps.map((s) => s.toolName)).toEqual(["viewResourceSnapshot", "gradeCandidates", "pickCandidate"]);
    expect(cards[1]?.round).toBe(1);
    expect(cards[1]?.heading).toContain("第 1 轮");
    expect(cards[1]?.heading).toContain("⚙️ 代码");
    expect(cards[1]?.heading).toContain("✗ 未命中");
    expect(cards[1]?.steps.map((s) => s.toolName)).toEqual(["transferCandidate", "stagingDigest", "digestFiles", "arbitrateDiagnosis"]);
    expect(cards[2]?.round).toBe(2);
    expect(cards[2]?.heading).toContain("✓ 命中");
    expect(cards[2]?.steps.map((s) => s.toolName)).toEqual(["transferCandidate", "stagingDigest"]);
  });

  it("老数据无 round 字段:回退为 transferCandidate 独立成轮 + 其余归决策链", () => {
    const steps: ActivityStepView[] = [
      step("gradeCandidates", "A 1 / B 0 / C 0 / D 0"),
      step("transferCandidate", "primary池候选 cX(1/3 次转存)", { candidateId: "cX" }),
      step("stagingDigest", "未通过(脏包):…"),
      step("finish", "入库:已在库"),
    ];
    const cards = groupStepsIntoRounds(steps);
    // 老数据:transferCandidate 独立成轮(round=1),stagingDigest 就近归轮;
    // 无轮次的决策/结论步骤按出现位置拆成前后两段决策链(gradeCandidates 前 / finish 后)。
    expect(cards[0]?.round).toBe(0);
    expect(cards[0]?.steps.map((s) => s.toolName)).toEqual(["gradeCandidates"]);
    expect(cards[1]?.round).toBe(1);
    expect(cards[1]?.steps.map((s) => s.toolName)).toEqual(["transferCandidate", "stagingDigest"]);
    expect(cards[2]?.round).toBe(0);
    expect(cards[2]?.steps.map((s) => s.toolName)).toEqual(["finish"]);
  });

  it("空数组 → 空卡片", () => {
    expect(groupStepsIntoRounds([])).toEqual([]);
  });

  it("decidedByLabel / poolLabel 文字标记", () => {
    expect(decidedByLabel("ai")).toBe("🤖 AI");
    expect(decidedByLabel("code")).toBe("⚙️ 代码");
    expect(decidedByLabel(undefined)).toBe("—");
    expect(poolLabel("fallback")).toBe("兜底池");
    expect(poolLabel("primary")).toBe("primary 池");
    expect(poolLabel(undefined)).toBe("primary 池");
  });
});