import { describe, expect, it } from "vitest";
import type { ActivityStepView } from "./activity-view";
import { decidedByLabel, groupStepsIntoRounds, poolLabel, roundVerdict } from "./step-rounds";

function step(
  toolName: string,
  activity: string,
  args: Record<string, unknown> = {},
  ordinal = 1,
): ActivityStepView {
  return { ordinal, toolName, activity, phase: "search", at: "2026-09-01T00:00:00Z", args, stepStatus: "success" };
}

describe("groupStepsIntoRounds", () => {
  it("真实形状:带 round 的转存链路分组——决策链/轮次卡/收尾卡顺序正确", () => {
    // 真实 emit 形状(B2 修复后):transfer round=attempted.size(1-based),stagingDigest round=同轮,retry 同轮。
    const steps: ActivityStepView[] = [
      step("viewResourceSnapshot", "候选 94 条"),
      step("gradeCandidates", "A 14 / B 80 / C 0 / D 0"),
      step("pickCandidate", "primary池唯一 A 盲转:候选 cX", { decidedBy: "code" }),
      step("transferCandidate", "primary池候选 cX(1/3 次转存)", { candidateId: "cX", round: 1, pool: "primary", decidedBy: "code", transferIndex: 1 }),
      step("stagingDigest", "未通过(脏包):…", { round: 1, passes: false, videoCount: 31, coveredCodes: { count: 1, sample: ["S02E06"] }, missingCodes: { count: 2, sample: ["S02E19", "S02E20"] } }),
      step("digestFiles", "逐文件解析 31 条", { files: ["a.mp4 → S02E06"], round: 1 }),
      step("arbitrateDiagnosis", "off-target 重试:换候选 cY(仲裁指定)", { round: 1, aiNext: "cY" }),
      step("transferCandidate", "primary池候选 cY(2/3 次转存)", { candidateId: "cY", round: 2, pool: "primary", decidedBy: "ai", transferIndex: 2 }),
      step("stagingDigest", "干净落地,覆盖 S02E19", { round: 2, passes: true, videoCount: 4, coveredCodes: { count: 2, sample: ["S02E19", "S02E20"] }, missingCodes: { count: 0, sample: [] } }),
      step("finalizeLanding", "改名归位 4 个文件"),
      step("finish", "入库(obtained=true)"),
    ];
    const cards = groupStepsIntoRounds(steps);
    // [决策链, 第1轮, 第2轮, 收尾]
    expect(cards.length).toBe(4);
    expect(cards[0]?.kind).toBe("decision");
    expect(cards[0]?.heading).toContain("搜索与选片");
    expect(cards[0]?.steps.map((s) => s.toolName)).toEqual(["viewResourceSnapshot", "gradeCandidates", "pickCandidate"]);
    expect(cards[1]?.kind).toBe("transfer");
    expect(cards[1]?.round).toBe(1);
    expect(cards[1]?.heading).toContain("第 1 次转存");
    // issue #29:决策来源移入 meta 区,标题不含 ⚙️。
    expect(cards[1]?.heading).not.toContain("未命中"); // L5 verdict 在 badge
    expect(cards[1]?.steps.map((s) => s.toolName)).toEqual(["transferCandidate", "stagingDigest", "digestFiles", "arbitrateDiagnosis"]);
    expect(cards[2]?.kind).toBe("transfer");
    expect(cards[2]?.round).toBe(2);
    expect(cards[2]?.heading).toContain("第 2 次转存");
    // L5 verdict 在 badge,heading 不重复
    expect(cards[2]?.steps.map((s) => s.toolName)).toEqual(["transferCandidate", "stagingDigest", "finalizeLanding"]);
    expect(cards[3]?.kind).toBe("closing");
    expect(cards[3]?.heading).toContain("收尾");
    expect(cards[3]?.steps.map((s) => s.toolName)).toEqual(["finish"]);
  });

  it("B1:映射救回场景——digest passes=false 但卡内 finalize 归位 → 判定 ✓", () => {
    const steps: ActivityStepView[] = [
      step("transferCandidate", "primary池候选 cX(1/3 次转存)", { candidateId: "cX", round: 1, pool: "primary", decidedBy: "code" }),
      step("stagingDigest", "未通过(未覆盖目标)", { round: 1, passes: false, videoCount: 12 }),
      step("arbitrateEpisodeMapping", "AI 映射:01.mp4 → S02E19,全部代码解析不出", { round: 1, aiUsed: true, mapping: [{ file: "01.mp4", code: "S02E19" }] }),
      step("finalizeLanding", "改名归位 1 个文件"),
    ];
    const cards = groupStepsIntoRounds(steps);
    expect(roundVerdict(cards[0]!)).toBe("pass"); // B1 三态:最终归位 → pass
  });


  it("Bug#1:归位失败(ok:false)的 finalizeLanding 不算 landed——不误判 ✓", () => {
    const steps: ActivityStepView[] = [
      step("transferCandidate", "primary池候选 cX(1/3 次转存)", { candidateId: "cX", round: 1, pool: "primary" }),
      step("stagingDigest", "未通过(未覆盖目标)", { round: 1, passes: false, videoCount: 8 }),
      step("finalizeLanding", "归位失败:转移异常", { ok: false }),
    ];
    const cards = groupStepsIntoRounds(steps);
    expect(roundVerdict(cards[0]!)).toBe("fail"); // 归位失败 → ✗,不是 ✓
  });
  it("Bug#1:归位成功(ok:true)算 landed → pass", () => {
    const steps: ActivityStepView[] = [
      step("transferCandidate", "primary池候选 cX(1/3 次转存)", { candidateId: "cX", round: 1, pool: "primary" }),
      step("stagingDigest", "未通过(未覆盖目标)", { round: 1, passes: false }),
      step("finalizeLanding", "改名归位 1 个文件", { ok: true }),
    ];
    const cards = groupStepsIntoRounds(steps);
    expect(roundVerdict(cards[0]!)).toBe("pass");
  });
  it("B2:abandon 后无下一转存——不造幻影卡,仲裁归死于当前轮,收尾卡承接结论", () => {
    const steps: ActivityStepView[] = [
      step("transferCandidate", "primary池候选 cX(1/3 次转存)", { candidateId: "cX", round: 1, pool: "primary" }),
      step("stagingDigest", "脏包", { round: 1, passes: false }),
      step("arbitrateDiagnosis", "放弃:暂无资源", { round: 1 }),
      step("reportNoCoverage", "暂无资源"),
      step("finish", "未入库"),
    ];
    const cards = groupStepsIntoRounds(steps);
    // 不应有「第 5 轮」幻影卡:仲裁 round=1 并回轮 1,收尾卡承接结论。
    expect(cards.some((c) => c.kind === "transfer" && c.round > 1)).toBe(false);
    const round1 = cards.find((c) => c.kind === "transfer");
    expect(round1?.steps.map((s) => s.toolName)).toEqual(["transferCandidate", "stagingDigest", "arbitrateDiagnosis"]);
    const closing = cards.find((c) => c.kind === "closing");
    expect(closing?.steps.map((s) => s.toolName)).toEqual(["reportNoCoverage", "finish"]);
  });

  it("B3:兜底池 systemic/dead 卡——pool 未标注时不谎报 primary,显示 —", () => {
    const steps: ActivityStepView[] = [
      step("transferCandidate", "候选 cX 死链(未落盘)", { candidateId: "cX", round: 3 }),
    ];
    const cards = groupStepsIntoRounds(steps);
    expect(cards[0]?.heading).toContain("第 3 次转存");
    // issue #29:标题不含池(黑话挪 meta);无候选标题时退回候选 id。
    expect(cards[0]?.heading).not.toContain("primary");
    expect(cards[0]?.heading).not.toContain("—");
  });

  it("B1:_truncated 塌缩——判定未知而不是 ✗", () => {
    const steps: ActivityStepView[] = [
      step("transferCandidate", "primary池候选 cX(1/3 次转存)", { candidateId: "cX", round: 1, pool: "primary" }),
      step("stagingDigest", "长包…", { _truncated: true }),
    ];
    const cards = groupStepsIntoRounds(steps);
    expect(roundVerdict(cards[0]!)).toBe("unknown"); // B1:塌缩 → 未知,不是 ✗
    expect(cards[0]?.heading).not.toContain("未命中");
  });

  it("老数据无 round:transfer 独立成轮(负序号)、结果步骤就近归轮、finish 收尾", () => {
    const steps: ActivityStepView[] = [
      step("gradeCandidates", "A 1 / B 0 / C 0 / D 0"),
      step("transferCandidate", "primary池候选 cX(1/3 次转存)", { candidateId: "cX" }),
      step("stagingDigest", "未通过(脏包):…"),
      step("finish", "入库:已在库"),
    ];
    const cards = groupStepsIntoRounds(steps);
    expect(cards[0]?.kind).toBe("decision");
    expect(cards[0]?.steps.map((s) => s.toolName)).toEqual(["gradeCandidates"]);
    const t = cards.find((c) => c.kind === "transfer");
    expect(t?.steps.map((s) => s.toolName)).toEqual(["transferCandidate", "stagingDigest"]);
    expect(t?.round).toBeLessThan(0); // 负序号,不与真实轮号撞车
    const closing = cards.find((c) => c.kind === "closing");
    expect(closing?.steps.map((s) => s.toolName)).toEqual(["finish"]);
  });


  it("REV:有转存轮后仍累积尾部决策桶——尾卡显示「搜索与选片」而非旧词「决策链」", () => {
    // 场景:primary 已转存(轮卡),随后兜底重搜/仲裁步骤无 round → 尾部决策桶
    const steps: ActivityStepView[] = [
      step("transferCandidate", "primary池候选 cX(1/3 次转存)", { candidateId: "cX", round: 1, pool: "primary" }),
      step("stagingDigest", "干净落地", { round: 1, passes: true }),
      step("searchResources", "keyword=「别名」(第 1/3 轮)", { keyword: "别名" }),
      step("gradeCandidates", "兜底合并池继续仲裁", { keyword: "别名" }),
      step("arbitrateSelection", "仲裁放弃:无可用候选", { reasoning: "无可用候选", selected: null }),
    ];
    const cards = groupStepsIntoRounds(steps);
    const tail = cards[cards.length - 1];
    expect(tail?.kind).toBe("decision");
    expect(tail?.heading).toBe("搜索与选片");
    expect(tail?.heading).not.toContain("决策链");
    expect(tail?.steps.map((s) => s.toolName)).toEqual(["searchResources", "gradeCandidates", "arbitrateSelection"]);
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
    expect(poolLabel(undefined)).toBe("—"); // B3 诚实回退
  });
});