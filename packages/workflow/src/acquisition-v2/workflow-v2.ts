// ★ 任务消费流水线 · 七阶段收口点（design §7）：①② 目录/清理 →
// consumption/stages/directories.ts；③ 需求与 no-op 早退 → consumption/stages/need.ts；
// ④–⑥ 装配连段 → consumption/stages/acquire.ts。本文件与 movie-workflow-v2 是
// 现役宿主（TV 侧已纯组合化）；步骤⑥ 删除空壳、pipeline 直接串接各阶段。
import { prepareDirectories, withStagingCleanupStage } from "../consumption/stages/directories.js";
import {
  computeNeed,
  noOpWorkflowStageResult,
  assembleNoOpWorkflowResult,
} from "../consumption/stages/need.js";
import {
  runAcquisitionCoreStage,
  type RunAcquisitionV2WorkflowRequest,
  type RunAcquisitionV2WorkflowResult,
  type V2WorkflowSeason,
} from "../consumption/stages/acquire.js";

// ★ 类型随 ④装配段迁至 consumption/stages/acquire.ts；出口名保留（bridge/测试引用）。
export type {
  RunAcquisitionV2WorkflowRequest,
  RunAcquisitionV2WorkflowResult,
  V2WorkflowSeason,
};

export async function runAcquisitionV2Workflow(
  request: RunAcquisitionV2WorkflowRequest,
): Promise<RunAcquisitionV2WorkflowResult> {
  // 7a — verify-or-create the directory tree, get scoped handles.
  // （①阶段实现已收口到 consumption/stages/directories.ts，此处直调。）
  const directories = await prepareDirectories({
    executor: request.executor,
    categoryParentId: request.categoryParentId,
    showName: request.title.name,
    year: request.title.year,
    tmdbId: request.title.tmdbId,
    seasons: request.seasons.map((season) => season.seasonNumber),
    workflowRunId: request.workflowRunId,
  });

  // Harness-level leak guard: whatever the agent does (covers, fails, or
  // reportNoCoverage), the run's staging dir is discarded when this returns or
  // throws — the 斗破苍穹 335-file leak fix. The agent keeps its own discardStaging
  // (and normally calls it); this is the deterministic backstop.
  return await withStagingCleanupStage(
    { executor: request.executor, stagingDirectoryId: directories.stagingDirectoryId },
    async () => {
  const seasonsForSync = request.seasons.map((season) => ({
    seasonNumber: season.seasonNumber,
    latestAiredEpisode: season.latestAiredEpisode,
  }));
  const priorObtained = request.priorObtained ?? [];

  // 7b — sync the need from the DB marks (应有 − 实有). No 115 scan, no parser.
  // （③阶段实现收口到 consumption/stages/need.ts —— 判空即零 API no-op 早退。）
  const before = computeNeed({ seasons: seasonsForSync, priorObtained });
  if (before.missing.length === 0) {
    // Already current — no agent run, no side effects (the type-3 no-op path).
    return assembleNoOpWorkflowResult(directories, noOpWorkflowStageResult(before));
  }

  // ★ ④(orchestrator 装配) → ⑤(对账) → ⑥(体积) 连段收口在 consumption/stages/acquire.ts。
  return await runAcquisitionCoreStage({
    request,
    directories,
    need: before,
    seasonsForSync,
    priorObtained,
  });

    },
  );
}
