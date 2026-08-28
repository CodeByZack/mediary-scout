import type { MovieWorkflowResult, WorkflowStatus } from "../domain.js";
import type { BridgedV2Result } from "../acquisition-v2/workflow-v2-bridge.js";
import {
  runMovieAcquisitionV2AndPersist,
  runSeriesInitializationV2AndPersist,
  runType2InitializationV2AndPersist,
  runType3MonitoringV2AndPersist,
} from "../runner-v2.js";
import type { ClaimedRun, ConsumptionContext, PatrolRun } from "./context.js";
import { resolveTvCategoryParent } from "./context.js";

/**
 * 任务消费流水线主干（design §2）：consumeClaimedRun(ctx) 七阶段 ——
 *
 *   ① prepareDirectories  确保 Show/Season/staging 目录树存在（verify-or-create）
 *   ② withStagingCleanup  包住 ③–⑥：成败必清 staging（335 文件泄漏兜底）
 *   ③ computeNeed         应有 − 实有；missing 空 → no_op（零搜索零转存零 LLM）
 *   ④ runAcquisition      装配沙盒 → 预搜 → 字幕预热 → tv/movie fast path 业务循环
 *   ⑤ reconcileNeed       跑后对账（prior ∪ agent 标记，不重扫网盘）
 *   ⑥ readLandedSize      通知用真实体积（best-effort，失败仅省略）
 *   ⑦ persistOutcome      结果 + 全部证据一次落库（kind 只在此处被 if）
 *
 * 步骤①（本文件当前形态）：纯转发骨架 —— 按 kind 分派到现有 runner 实现（它们
 * 内部已按此顺序执行 ①–⑦），行为零变化；②–⑤ 的搬迁会逐阶段把转发替换成
 * consumption/stages/* 的真实实现。
 *
 * 异常语义（对齐讨论 · 出入 C）：pipeline 不吞任何阶段异常、也不调
 * handleWorkflowRunFailure —— 由调用方分派：队列认领侧套现有 failure handler
 * （瞬态退避重入队/终态清 episode 态），type3/movie 巡检侧保留自己的 catch（不
 * 重试、保留 episode 态、直接写 failed）。与今天逐调用点行为完全一致。
 */

/** 一次消费的产物。②–⑤ 收口后演进为 design §3 的 ConsumptionResult。 */
export interface ConsumeOutcome {
  /** 队列侧/巡检侧组装 { status: "ran", workflowStatus } 用的终态。 */
  workflowStatus: WorkflowStatus;
  /** 转发阶段保留原始结果（type1/type2/type3 → BridgedV2Result；movie → MovieWorkflowResult）。 */
  result: BridgedV2Result | MovieWorkflowResult;
}

function requireClaimed(ctx: ConsumptionContext): ClaimedRun {
  if (!ctx.claimed) {
    throw new Error(`consumeClaimedRun: kind=${ctx.kind} 的队列消费上下文缺少 claimed run`);
  }
  return ctx.claimed;
}

function requirePatrol(ctx: ConsumptionContext): PatrolRun {
  if (!ctx.patrol) {
    throw new Error(`consumeClaimedRun: kind=${ctx.kind} 的巡检上下文缺少 patrol run`);
  }
  return ctx.patrol;
}

/** 能力透传（替代 runner-v2 的 passthrough()，从 ctx 读取）。 */
function capabilitySpread(ctx: ConsumptionContext): {
  preferredLanguage?: string;
  qualityPreference?: "high" | "medium";
  storageProvider?: string;
  assrtToken?: string;
} {
  return {
    ...(ctx.preferredLanguage === undefined ? {} : { preferredLanguage: ctx.preferredLanguage }),
    ...(ctx.qualityPreference === undefined ? {} : { qualityPreference: ctx.qualityPreference }),
    ...(ctx.storageProvider === undefined ? {} : { storageProvider: ctx.storageProvider }),
    ...(ctx.assrtToken === undefined ? {} : { assrtToken: ctx.assrtToken }),
  };
}

function clockSpread(ctx: ConsumptionContext): { now?: () => string } {
  return ctx.now === undefined ? {} : { now: ctx.now };
}

function resolveMoviesParent(ctx: ConsumptionContext): string {
  // 队列 movie 认领侧的类型保证（runQueuedMovieAcquisition.moviesParentDirectoryId:
  // string 必填）；兜底仅为类型收口，正常路径不可达（错误文案沿用 TV 侧惯例）。
  return ctx.moviesParentDirectoryId ?? requireCategoryParentMovies();
}

function requireCategoryParentMovies(): never {
  throw new Error(
    "MEDIA_TRACK_CATEGORY_PARENT_REQUIRED: a library category parent (Movies/TV/Anime) is required for directory verify-or-create",
  );
}

/** ★ 唯一消费入口：认领成功后跑完 ①–⑦（design §2）。 */
export async function consumeClaimedRun(ctx: ConsumptionContext): Promise<ConsumeOutcome> {
  switch (ctx.kind) {
    case "type2_init": {
      const claimed = requireClaimed(ctx);
      const bridged = await runType2InitializationV2AndPersist({
        title: ctx.title,
        season: claimed.snapshot.season,
        // ①目录阶段的父级选择：在转发调用前抛错，与今天在 try 内构造参数的时序一致。
        categoryParentId: resolveTvCategoryParent(ctx),
        resourceProvider: ctx.resourceProvider,
        storage: ctx.storage,
        model: ctx.model,
        repository: ctx.repository,
        accountId: claimed.snapshot.accountId,
        connectedStorageId: claimed.snapshot.connectedStorageId,
        ...capabilitySpread(ctx),
        workflowRun: {
          id: claimed.runId,
          startedAt: claimed.startedAt,
          finishedAt: null,
        },
        ...clockSpread(ctx),
      });
      return { workflowStatus: bridged.status, result: bridged };
    }

    case "type1_package_init": {
      const claimed = requireClaimed(ctx);
      if (claimed.seasonScopes.length === 0) {
        throw new Error("Queued series initialization run is missing its season metadata");
      }
      const bridged = await runSeriesInitializationV2AndPersist({
        title: ctx.title,
        seasons: claimed.seasonScopes,
        categoryParentId: resolveTvCategoryParent(ctx),
        seasonQualityRecord: claimed.snapshot.season.qualityPreference,
        resourceProvider: ctx.resourceProvider,
        storage: ctx.storage,
        model: ctx.model,
        repository: ctx.repository,
        accountId: claimed.snapshot.accountId,
        connectedStorageId: claimed.snapshot.connectedStorageId,
        ...capabilitySpread(ctx),
        workflowRun: {
          id: claimed.runId,
          startedAt: claimed.startedAt,
          finishedAt: null,
        },
        ...clockSpread(ctx),
      });
      // Finalize the claimed lock run itself; it doubles as season 1's summary
      // record (same tracked season and episode state as the persisted _s1 run).
      // （原 runQueuedSeriesInitialization 尾段落库，逐字搬迁 —— type1 的 ⑦ 差异。）
      const now = ctx.now ?? (() => new Date().toISOString());
      const firstSeason = bridged.seasons[0];
      await ctx.repository.saveWorkflowRunSnapshot({
        accountId: claimed.snapshot.accountId,
        connectedStorageId: claimed.snapshot.connectedStorageId,
        title: claimed.snapshot.title,
        season: firstSeason?.season ?? claimed.snapshot.season,
        workflowRun: {
          ...claimed.snapshot.workflowRun,
          status: bridged.status,
          finishedAt: now(),
          auditEvents: [
            ...claimed.snapshot.workflowRun.auditEvents,
            ...bridged.auditEvents,
          ],
        },
        episodes: firstSeason?.episodes ?? [],
        resourceSnapshots: [],
        decisions: [],
        transferAttempts: [],
        notifications: [],
      });
      return { workflowStatus: bridged.status, result: bridged };
    }

    case "movie_init": {
      const claimed = requireClaimed(ctx);
      const result = await runMovieAcquisitionV2AndPersist({
        title: ctx.title,
        categoryParentId: resolveMoviesParent(ctx),
        resourceProvider: ctx.resourceProvider,
        storage: ctx.storage,
        model: ctx.model,
        repository: ctx.repository,
        accountId: claimed.snapshot.accountId,
        connectedStorageId: claimed.snapshot.connectedStorageId,
        ...capabilitySpread(ctx),
        workflowRun: {
          id: claimed.runId,
          startedAt: claimed.startedAt,
          finishedAt: null,
        },
        ...clockSpread(ctx),
      });
      return { workflowStatus: result.status, result };
    }

    case "type3_monitor": {
      // 决策 1：type3 巡检直调本入口。巡检侧的 reserve/失败 catch 留在认领侧，
      // pipeline 只负责跑 ①–⑦（转发形态下即现有 runner 包装）。
      const patrol = ctx.patrol ? requirePatrol(ctx) : null;
      if (!patrol) {
        // 队列里不存在 type3_monitor 认领（巡检 run 不入队）——直调上下文缺失即配置错。
        throw new Error("type3 consumption requires a patrol context (巡检不入队，直调 pipeline)");
      }
      const bridged = await runType3MonitoringV2AndPersist({
        title: ctx.title,
        season: patrol.season,
        episodes: patrol.episodes,
        categoryParentId: resolveTvCategoryParent(ctx),
        resourceProvider: ctx.resourceProvider,
        storage: ctx.storage,
        model: ctx.model,
        repository: ctx.repository,
        accountId: patrol.accountId,
        connectedStorageId: patrol.connectedStorageId,
        ...capabilitySpread(ctx),
        workflowRun: {
          id: patrol.runId,
          startedAt: patrol.startedAt,
          finishedAt: null,
        },
        ...clockSpread(ctx),
      });
      return { workflowStatus: bridged.status, result: bridged };
    }
  }
}
