/**
 * 活动页/通知页「按转存轮次卡片化」的纯分组逻辑(issue #29 展示层)。
 * 输入是活动页拿到的 ActivityStepView[];输出是分好组的卡片列表。
 *
 * 分组规则(基于步骤的结构化字段,老数据无字段时优雅回退):
 *  - transferCandidate 且 args.round 存在 → 新轮次卡(kind=transfer,卡片标题用 round);
 *  - 同 round 的 stagingDigest/digestFiles/arbitrateEpisodeMapping/arbitrateDiagnosis
 *    → 并入该轮卡片;
 *  - 无 round 的 transferCandidate(老数据)→ 独立成轮(fallbackRoundSeq);
 *  - 搜索/评分/选片 等 pre-transfer 步骤 → 「决策链」卡(kind=decision);
 *  - finalizeLanding/finish 等收尾步骤 → 「收尾」卡(kind=closing);
 *  - 保持原始顺序。
 */
import type { ActivityStepView } from "./activity-view";

/** 卡片种类:transfer=转存轮次;decision=搜索/评分/选片决策链;closing=收尾/结论。 */
export type StepCardKind = "transfer" | "decision" | "closing";

export interface StepRoundCard {
  /** transfer 的轮次号(N≥1);decision/closing 无轮次,round 为 0(哨兵)。 */
  round: number;
  kind: StepCardKind;
  /** 卡片标题(含 pool/decidedBy/verdict 归纳)。 */
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
  if (value === "fallback") return "兜底池";
  if (value === "primary") return "primary 池";
  return "—"; // B3:未知时诚实显示,不谎报 primary。
}

/** 从一组步骤里找第一个非 undefined 的 pool(卡头展示;避免锚点退化时谎报)。 */


/** 轮次卡的最终判定(B1 三态):pass=digest 通过或最终归位;fail=digest 未通过且未归位;
 *  unknown=args 被 trace-sink 塌缩(无 passes);空=无 digest(非转存卡)。 */
export function roundVerdict(card: StepRoundCard): "pass" | "fail" | "unknown" | "" {
  const digest = card.steps.find((s) => s.toolName === "stagingDigest");
  // 归位成功才算 landed:finalizeLanding/finish 带 ok:false(失败)不算(Bug#1 防假阳性)。
  const landed = card.steps.some((s) => (s.toolName === "finalizeLanding" || s.toolName === "finish") && s.args?.["ok"] !== false);
  const digestPass = digest?.args?.["passes"] === true;
  const truncated = digest !== undefined && digest.args?.["_truncated"] === true;
  if (!digest) return "";
  if (digestPass || landed) return "pass";
  return truncated ? "unknown" : "fail";
}

/**(纯函数;老数据无 round 字段时回退为「无轮次信息的步骤列表」)。
 * 注意:StepList 先判 hasRounds 再调本函数,纯老数据直接走扁平渲染——“部分步骤被塌缩”
 * 的混合 run 才会真正走进这里。
 */
export function groupStepsIntoRounds(steps: ActivityStepView[]): StepRoundCard[] {
  if (steps.length === 0) return [];
  const cards: StepRoundCard[] = [];
  const decisionSteps: ActivityStepView[] = [];
  const closingSteps: ActivityStepView[] = [];
  let currentRound: number | null = null;
  let fallbackRoundSeq = 0;

  const flush = (bucket: ActivityStepView[], kind: StepCardKind, label: string) => {
    if (bucket.length === 0) return;
    cards.push({ round: 0, kind, heading: label, steps: bucket.splice(0) });
  };

  const isTransferResultStep = (toolName: string) =>
    ["stagingDigest", "digestFiles", "arbitrateEpisodeMapping", "arbitrateDiagnosis", "finalizeLanding"].includes(toolName);

  for (const step of steps) {
    const round = roundOf(step);
    // 有 round 的任意步骤 → 归入该轮(transfer 是锚点,digest 等并轮)。
    if (round !== undefined) {
      let card = cards.find((c) => c.kind === "transfer" && c.round === round);
      if (!card) {
        // 新轮:先把已攒的决策链 flush(内容在轮之前),再开轮卡。
        // issue #29 用户反馈:「决策链」难懂 → 「搜索与选片」。
        flush(decisionSteps, "decision", "搜索与选片");
        flush(closingSteps, "closing", "收尾");
        card = { round, kind: "transfer", heading: "", steps: [] };
        cards.push(card);
      }
      card.steps.push(step);
      currentRound = round;
      continue;
    }
    // 无 round。老数据回退:transferCandidate 独立成轮;结果步骤就近归当前轮;
    // 收尾步骤(finalize/finish)归收尾卡;其余 pre-transfer 步骤归决策链。
    if (step.toolName === "transferCandidate") {
      flush(decisionSteps, "decision", "搜索与选片");
      flush(closingSteps, "closing", "收尾");
      fallbackRoundSeq -= 1; // L1:老数据序号与真实轮号撞车——用负序号避开真实轮号(1..6)。
      const card = { round: fallbackRoundSeq, kind: "transfer" as const, heading: "", steps: [step] };
      cards.push(card);
      currentRound = fallbackRoundSeq;
      continue;
    }
    if (isTransferResultStep(step.toolName)) {
      const card = currentRound !== null ? cards.find((c) => c.kind === "transfer" && c.round === currentRound) : undefined;
      if (card) {
        card.steps.push(step);
        continue;
      }
    }
    // 收尾步骤(finalizeLanding/finish/reportNoCoverage/conclude)归收尾卡,其余归决策链。
    const closingTools = ["finish", "reportNoCoverage", "concludeUncovered"];
    if (closingTools.includes(step.toolName)) closingSteps.push(step);
    else decisionSteps.push(step);
  }
  flush(decisionSteps, "decision", "决策链");
  flush(closingSteps, "closing", "收尾");

  // 生成标题:decision/closing 用固定名;transfer 归纳 pool/decidedBy/candidate/verdict。
  for (const card of cards) {
    if (card.kind !== "transfer") continue;
    const transfer = card.steps.find((s) => s.toolName === "transferCandidate");
    // B1 单一事实来源:判定走 roundVerdict(badge 消费),标题不含 verdict。
    const candidate = transfer?.args?.["candidateId"] ?? "";
    const shortId = typeof candidate === "string" && candidate.length > 28 ? "…" + candidate.slice(-20) : String(candidate ?? "");
    const roundLabel = card.round > 0 ? `第 ${card.round} 次转存` : "未记录轮次";
    // issue #29 用户反馈:标题要直白——「第 N 次转存 · 《候选标题》」;
    // pool/决策者不进标题(黑话),转由卡片 meta 区展示(⚙️代码/🤖AI 文字标记)。
    const candidateTitle = typeof transfer?.args?.["title"] === "string" && transfer.args["title"].length > 0 ? transfer.args["title"] : "";
    const headTitle = candidateTitle ? `《${candidateTitle.slice(0, 26)}${candidateTitle.length > 26 ? "…" : ""}》` : (shortId && shortId !== "undefined" ? `候选 ${shortId}` : "转存");
    card.heading = `${roundLabel} · ${headTitle}`;
  }
  return cards;
}
/** 判断步骤列表是否含结构化轮次信息(有 transferCandidate 且带 round)。
 *  StepList 用此决定卡片化 vs 扁平;纯函数便于测试。 */
export function hasRoundStructure(steps: ActivityStepView[]): boolean {
  return steps.some((s) => s.toolName === "transferCandidate" && typeof s.args?.["round"] === "number");
}
