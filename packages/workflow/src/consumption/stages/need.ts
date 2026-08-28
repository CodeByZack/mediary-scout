import type { AuditEvent } from "../../domain.js";
import type { AcquisitionV2Outcome } from "../../acquisition-v2/orchestrator.js";
import { syncSeasonNeed } from "../../acquisition-v2/sync-need.js";
import type { AcquisitionDirectories } from "../../acquisition-v2/directory-lifecycle.js";

/**
 * 七阶段之 ③computeNeed / ⑤reconcileNeed（design §2、§3、§7）。
 *
 * ③⑤ 都是纯 DB 计算（不扫网盘、不烧 token、零 API）：need = 应有 − 实有。
 * ③ 判空 → no_op：type3 日常零成本的根基，零 API 早退路径。
 * ⑤ 跑后对账用 agent 的覆盖标记（prior ∪ 本轮 obtained），不重扫网盘
 * （§1.13/§7b 语义逐字保留）。
 */

/** need 计算的季形状（workflow-v2 与 movie-workflow-v2 的 syncSeasonNeed 入参并集）。 */
export interface NeedSeason {
  seasonNumber: number;
  /** Aired up to this episode (should-exist = E01..latestAiredEpisode). */
  latestAiredEpisode: number;
}

export interface NeedSnapshot {
  /** 缺的集码（SxxExx）。 */
  missing: string[];
  /** 实有集码。 */
  obtained: string[];
  /** provider 声称有但应有范围外的（对账噪音，照实透传）。 */
  providerAhead: string[];
}

/** ③ 跑前需求快照。 */
export function computeNeed(input: {
  seasons: NeedSeason[];
  priorObtained: string[];
}): NeedSnapshot {
  const snapshot = syncSeasonNeed({
    seasons: input.seasons,
    obtained: input.priorObtained,
  });
  return {
    missing: snapshot.missing,
    obtained: snapshot.obtained,
    providerAhead: snapshot.providerAhead,
  };
}

/** ⑤ 跑后对账：实有 = 认领侧 prior DB 标记 ∪ agent 本轮 markObtained。 */
export function reconcileNeed(input: {
  seasons: NeedSeason[];
  priorObtained: string[];
  newlyObtained: string[];
}): NeedSnapshot {
  const snapshot = syncSeasonNeed({
    seasons: input.seasons,
    obtained: [...input.priorObtained, ...input.newlyObtained],
  });
  return {
    missing: snapshot.missing,
    obtained: snapshot.obtained,
    providerAhead: snapshot.providerAhead,
  };
}

/** ③ 判空 → 零 API no-op 结果（workflow-v2 早退路径的产物形状，逐字等价）。 */
export const EMPTY_ACQUISITION_OUTCOME: AcquisitionV2Outcome = {
  resourceSnapshots: [],
  decisions: [],
  transferAttempts: [],
};

export interface NoOpWorkflowStageResult {
  outcome: AcquisitionV2Outcome;
  agentText: string;
  missingBefore: string[];
  stillMissing: string[];
  obtained: string[];
  providerAhead: string[];
  auditEvents: AuditEvent[];
}

export function noOpWorkflowStageResult(need: NeedSnapshot): NoOpWorkflowStageResult {
  return {
    outcome: EMPTY_ACQUISITION_OUTCOME,
    agentText: "",
    missingBefore: [],
    stillMissing: [],
    obtained: need.obtained,
    providerAhead: need.providerAhead,
    auditEvents: [],
  };
}

/** no-op 结果的完整 workflow 形状（含 ① 的目录产物；landed 体积 no-op 不读，与今天一致）。 */
export function assembleNoOpWorkflowResult(
  directories: AcquisitionDirectories,
  noop: NoOpWorkflowStageResult,
): {
  directories: AcquisitionDirectories;
  missingBefore: string[];
  outcome: AcquisitionV2Outcome;
  agentText: string;
  stillMissing: string[];
  obtained: string[];
  providerAhead: string[];
  auditEvents: AuditEvent[];
} {
  return { directories, ...noop };
}
