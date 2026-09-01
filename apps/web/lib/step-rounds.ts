/**
 * 活动页/通知页「按转存轮次卡片化」的纯分组逻辑(issue #29 展示层)。
 * 输入是活动页拿到的 ActivityStepView[];输出是分好组的卡片列表。
 *
 * 分组规则(基于步骤的结构化字段,老数据无字段时优雅回退):
 *  - transferCandidate 且 args.round 存在 → 新轮次锚点(卡片标题用 round);
 *  - 同 round 的 stagingDigest/digestFiles/arbitrateEpisodeMapping/arbitrateDiagnosis
 *    → 并入该轮卡片;
 *  - 无 round 的 transferCandidate(老数据)→ 独立成一轮(round = 序号);
 *  - 搜索/评分/选片/结论 等非转存步骤 → 归「决策链」顶部卡片(round=0);
 *  - 保持原始顺序。
 */
import type { ActivityStepView } from "./activity-view";

export interface StepRoundCard {
  /** 0 = 决策链(搜索/评分/选片/结论);N = 第 N 轮转存。 */
  round: number;
  /** 卡片标题后缀:pool + decidedBy + 判定(passes)。 */
  heading: string;
  steps: ActivityStepView[];
}

/** 从步骤 args 读 round(新字段);无则 undefined。 */
function roundOf(step: ActivityStepView): number | undefined {
  const value = step.args?.["round"];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 从步骤 args 读 pool(primary/fallback);无则 undefined。 */
function poolOf(step: ActivityStepView): "primary" | "fallback" | undefined {
  const value = step.args?.["pool"];
  return value === "primary" || value === "fallback" ? value : undefined;
}

/** 从步骤 args 读 decidedBy(code/ai);无则 undefined。 */
function decidedByOf(step: ActivityStepView): "code" | "ai" | undefined {
  const value = step.args?.["decidedBy"];
  return value === "code" || value === "ai" ? value : undefined;
}

/** 卡片标题的决策来源标记:⚙️ 代码 / 🤖 AI。 */
export function decidedByLabel(value: "code" | "ai" | undefined): string {
  if (value === "ai") return "🤖 AI";
  if (value === "code") return "⚙️ 代码";
  return "—";
}

/** primary/fallback 到中文标签。 */
export function poolLabel(value: "primary" | "fallback" | undefined): string {
  return value === "fallback" ? "兜底池" : "primary 池";
}

/**
 * 把平铺步骤按转存轮次分组(纯函数;老数据无 round 字段时回退为「无轮次信息的步骤列表」)。
 */
export function groupStepsIntoRounds(steps: ActivityStepView[]): StepRoundCard[] {
  if (steps.length === 0) return [];
  const cards: StepRoundCard[] = [];
  const decisionSteps: ActivityStepView[] = [];
  let currentRound: number | null = null;
  let fallbackRoundSeq = 0;

  const pushDecision = () => {
    if (decisionSteps.length === 0) return;
    cards.push({ round: 0, heading: "决策链", steps: decisionSteps.splice(0) });
  };

  for (const step of steps) {
    const round = roundOf(step);
    if (step.toolName === "transferCandidate") {
      if (round !== undefined) {
        // 新轮开始前,先把已攒的决策步骤 flush 成「决策链」卡片(保持原始顺序)。
        pushDecision();
        // 有结构化 round:落进该轮次的卡片(新轮或被既有轮吸收)。
        let card = cards.find((c) => c.round === round);
        if (!card) {
          card = { round, heading: "", steps: [] };
          cards.push(card);
        }
        card.steps.push(step);
        currentRound = round;
      } else {
        // 老数据:无 round 的 transferCandidate 独立成轮(顺序序号)。
        pushDecision();
        fallbackRoundSeq += 1;
        const card = { round: fallbackRoundSeq, heading: "", steps: [step] };
        cards.push(card);
        currentRound = fallbackRoundSeq;
      }
      continue;
    }
    // 非 transferCandidate:有 round(同轮收尾步骤)则并入对应卡片,否则暂存决策链。
    if (round !== undefined && currentRound !== null && round === currentRound) {
      const card = cards.find((c) => c.round === round);
      if (card) card.steps.push(step);
      else {
        const ncard = { round, heading: "", steps: [step] };
        cards.push(ncard);
        currentRound = round;
      }
      continue;
    }
    if (round !== undefined) {
      // 新轮次的开头步骤(如 stagingDigest round=N 独立出现)也吸收。
      let card = cards.find((c) => c.round === round);
      if (!card) {
        card = { round, heading: "", steps: [] };
        cards.push(card);
      }
      card.steps.push(step);
      currentRound = round;
      continue;
    }
    // 老数据回退:转存结果步骤(stagingDigest/digestFiles/映射/诊断)若紧跟在某轮之后,
    // 就近归入该轮(它们描述的是「这一轮转存发生了什么」),而不是甩进决策链。
    if (
      currentRound !== null &&
      ["stagingDigest", "digestFiles", "arbitrateEpisodeMapping", "arbitrateDiagnosis"].includes(step.toolName)
    ) {
      const card = cards.find((c) => c.round === currentRound);
      if (card) {
        card.steps.push(step);
        continue;
      }
    }
    decisionSteps.push(step);
  }
  pushDecision();

  // 生成卡片标题(pool/decidedBy/判定从卡片内步骤归纳)。
  for (const card of cards) {
    if (card.round === 0) {
      card.heading = "决策链";
      continue;
    }
    const transfer = card.steps.find((s) => s.toolName === "transferCandidate");
    const digest = card.steps.find((s) => s.toolName === "stagingDigest");
    const first = card.steps[0];
    const anchor = transfer ?? first;
    const pool = anchor === undefined ? undefined : poolOf(anchor);
    const decided = anchor === undefined ? undefined : decidedByOf(anchor);
    const passes = digest?.args?.["passes"] === true;
    const verdict = digest ? (passes ? "✓ 命中" : "✗ 未命中") : "";
    const candidate = transfer?.args?.["candidateId"] ?? "";
    const shortId = typeof candidate === "string" && candidate.length > 28 ? "…" + candidate.slice(-20) : String(candidate ?? "");
    card.heading = `第 ${card.round} 轮 · ${poolLabel(pool)} · ${decidedByLabel(decided)}${shortId ? ` · ${shortId}` : ""}${verdict ? ` · ${verdict}` : ""}`;
  }
  return cards;
}