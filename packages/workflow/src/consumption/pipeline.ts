import type { MovieWorkflowResult, WorkflowStatus } from "../domain.js";
import type { BridgedV2Result } from "../acquisition-v2/workflow-v2-bridge.js";
import { compilePromptLookup, loadEpisodeRules, loadPromptOverrides } from "../ruleset.js";
import { runTvAcquisitionV2 } from "../acquisition-v2/run-tv-v2.js";
import { runMovieAcquisitionV2 } from "../movie-workflow-v2.js";
import type { ClaimedRun, ConsumptionContext, PatrolRun } from "./context.js";
import { requireCategoryParent, resolveTvCategoryParent } from "./context.js";
import {
  persistMovieRun,
  persistSeriesLockRun,
  persistSeriesSeasons,
  persistSingleSeason,
  progressAndTraceSink,
  resolveNow,
} from "./stages/persist.js";

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
 * 阶段实现位置：①②⑥ → stages/directories.ts；③⑤ → stages/need.ts；④ 装配 →
 * stages/acquire.ts（TV 连段）+ orchestrator/movie-workflow-v2（器件宿主）；
 * ⑦ → stages/persist.ts。四个 kind 分支全部真组合 —— runner-v2 已整体退场
 * （步骤⑥）：kind 差异只在认领优先级表与 ⑦ 落库口径两处收口。
 *
 * 异常语义（对齐讨论 · 出入 C）：pipeline 不吞任何阶段异常、也不调
 * handleWorkflowRunFailure —— 由调用方分派：队列认领侧套现有 failure handler
 * （瞬态退避重入队/终态清 episode 态），type3/movie 巡检侧保留自带 catch（不
 * 重试、保留 episode 态、直接写 failed）。与今天逐调用点行为完全一致。
 */

/** 一次消费的产物。 */
export interface ConsumeOutcome {
  /** 队列侧/巡检侧组装 { status: "ran", workflowStatus } 用的终态。 */
  workflowStatus: WorkflowStatus;
  /** 原始结果（type1/type2/type3 → BridgedV2Result；movie → MovieWorkflowResult）。 */
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

function resolveMoviesParent(ctx: ConsumptionContext): string {
  // 队列 movie 认领侧的类型保证（runQueuedMovieAcquisition.moviesParentDirectoryId
  // 必填）；兜底仅为类型收口，正常路径不可达（fail-loud 文案沿用 TV 侧惯例）。
  return requireCategoryParent(ctx.moviesParentDirectoryId);
}

/** ★ 唯一消费入口：认领成功后跑完 ①–⑦（design §2）。 */
export async function consumeClaimedRun(ctx: ConsumptionContext): Promise<ConsumeOutcome> {
  // issue #44:每轮任务认领时加载一次生效规则(空表/损坏自动回退内置)。movie 分支
  // 不解析集数(身份判据是标题+年份),跳过加载。
  const episodeRules =
    ctx.kind === "movie_init" ? undefined : await loadEpisodeRules(ctx.repository);
  // issue #44 Phase 2:AI 仲裁 prompt 覆盖(kind → body)。TV/movie 都要。
  const promptLookup = compilePromptLookup(await loadPromptOverrides(ctx.repository));
  switch (ctx.kind) {
    case "type2_init": {
      const claimed = requireClaimed(ctx);
      const now = resolveNow(ctx);
      const season = claimed.snapshot.season;
      // ①–⑥（策略装配 → 目录 → 需求 → 沙盒快路径 → 对账 → 体积 + 通知口径 bridge）。
      const bridged = await runTvAcquisitionV2({
        title: ctx.title,
        mode: "type2",
        seasons: [
          {
            seasonNumber: season.seasonNumber,
            totalEpisodes: season.totalEpisodes,
            latestAiredEpisode: season.latestAiredEpisode,
            qualityPreference: season.qualityPreference,
            status: season.status,
          },
        ],
        categoryParentId: resolveTvCategoryParent(ctx),
        resourceProvider: ctx.resourceProvider,
        storage: ctx.storage,
        deadLinkStore: ctx.repository,
        model: ctx.model,
        workflowRunId: claimed.runId,
        // 年守卫数据:入队时(prepareTrackingTarget)已把 TMDB 各集播出日写进
        // 认领快照的 episode_states;缺省 = 守卫惰性,旧语义原样。
        episodeAirDates: Object.fromEntries(
          claimed.snapshot.episodes.flatMap((episode) =>
            episode.airDate === null
              ? []
              : [[episode.episodeCode, episode.airDate] as const],
          ),
        ),
        // 综艺 Part 锚定数据:TMDB 原始 name 已在 episode_states.title(createEpisodeStates
        // 用 episodeNames 生成);「第N期上/下 ↔ Episode N (Part 1/2)」靠它定位。
        episodeNames: Object.fromEntries(
          claimed.snapshot.episodes.flatMap((episode) =>
            !episode.title || /^Episode \d+$/.test(episode.title)
              ? []
              : [[episode.episodeCode, episode.title] as const],
          ),
        ),
        ...(episodeRules !== undefined ? { episodeRules } : {}),
        ...(Object.keys(promptLookup).length > 0 ? { promptOverrides: promptLookup } : {}),
        now,
        onProgress: progressAndTraceSink({
          repository: ctx.repository,
          workflowRunId: claimed.runId,
          neededHint: Math.min(season.latestAiredEpisode, season.totalEpisodes),
          storage: ctx.storage,
        }),
        ...capabilitySpread(ctx),
      });
      // ⑦ type2：单季记录。Stamp finishedAt AFTER the run — it (and the
      // notification createdAt) must be the real completion time, not the
      // claim time.
      await persistSingleSeason({
        kind: "type2_init",
        title: ctx.title,
        bridged,
        workflowRun: { id: claimed.runId, startedAt: claimed.startedAt, finishedAt: now() },
        repository: ctx.repository,
        accountId: claimed.snapshot.accountId,
        connectedStorageId: claimed.snapshot.connectedStorageId,
      });
      return { workflowStatus: bridged.status, result: bridged };
    }

    case "type1_package_init": {
      const claimed = requireClaimed(ctx);
      if (claimed.seasonScopes.length === 0) {
        throw new Error("Queued series initialization run is missing its season metadata");
      }
      const now = resolveNow(ctx);
      // seasonQualityRecord 是 LEGACY 逐季记录字符串（如 "4K"），区别于
      // ctx.qualityPreference（high/medium，走 qualityGuidance）。
      const quality = claimed.snapshot.season.qualityPreference ?? "4K";
      const bridged = await runTvAcquisitionV2({
        title: ctx.title,
        mode: "series",
        seasons: claimed.seasonScopes.map((season) => ({
          seasonNumber: season.seasonNumber,
          totalEpisodes: season.totalEpisodes,
          latestAiredEpisode: season.latestAiredEpisode,
          qualityPreference: quality,
        })),
        categoryParentId: resolveTvCategoryParent(ctx),
        resourceProvider: ctx.resourceProvider,
        storage: ctx.storage,
        deadLinkStore: ctx.repository,
        model: ctx.model,
        workflowRunId: claimed.runId,
        ...(episodeRules !== undefined ? { episodeRules } : {}),
        ...(Object.keys(promptLookup).length > 0 ? { promptOverrides: promptLookup } : {}),
        now,
        onProgress: progressAndTraceSink({
          repository: ctx.repository,
          workflowRunId: claimed.runId,
          neededHint: claimed.seasonScopes.reduce(
            (sum, season) => sum + Math.min(season.latestAiredEpisode, season.totalEpisodes),
            0,
          ),
          storage: ctx.storage,
        }),
        ...capabilitySpread(ctx),
      });
      // ⑦ type1：一季一条（${runId}_s${n}）+ claimed 锁 run 收尾（season 1 摘要记录）。
      const finishedAt = now();
      await persistSeriesSeasons({
        title: ctx.title,
        bridged,
        workflowRun: { id: claimed.runId, startedAt: claimed.startedAt, finishedAt: null },
        finishedAt,
        repository: ctx.repository,
        accountId: claimed.snapshot.accountId,
        connectedStorageId: claimed.snapshot.connectedStorageId,
      });
      await persistSeriesLockRun({
        snapshot: claimed.snapshot,
        bridged,
        repository: ctx.repository,
        finishedAt,
      });
      return { workflowStatus: bridged.status, result: bridged };
    }

    case "movie_init": {
      const claimed = requireClaimed(ctx);
      const now = resolveNow(ctx);
      // ①–⑥：movie 宿主（落点检查/清理重转/字幕软目标/归位都在其内 —— 器件）。
      const result = await runMovieAcquisitionV2({
        title: ctx.title,
        resourceProvider: ctx.resourceProvider,
        storage: ctx.storage,
        model: ctx.model,
        workflowRunId: claimed.runId,
        moviesParentDirectoryId: resolveMoviesParent(ctx),
        now,
        deadLinkStore: ctx.repository,
        ...(Object.keys(promptLookup).length > 0 ? { promptOverrides: promptLookup } : {}),
        onProgress: progressAndTraceSink({
          repository: ctx.repository,
          workflowRunId: claimed.runId,
          neededHint: 1,
          storage: ctx.storage,
        }),
        ...capabilitySpread(ctx),
      });
      // ⑦ movie：单记录、kind=movie_init、集状态由引擎自带。
      await persistMovieRun({
        title: ctx.title,
        result,
        workflowRun: { id: claimed.runId, startedAt: claimed.startedAt, finishedAt: null },
        finishedAt: now(),
        repository: ctx.repository,
        accountId: claimed.snapshot.accountId,
        connectedStorageId: claimed.snapshot.connectedStorageId,
      });
      return { workflowStatus: result.status, result };
    }

    case "type3_monitor": {
      // 决策 1：type3 巡检直调本入口（步骤⑥收口）。原 runner 包装的
      // priorObtained（DB obtained 标记为实有、不重扫网盘）与 neededHint
      // （aired 未 obtained 计数）语义逐字接管。
      const patrol = requirePatrol(ctx);
      const now = resolveNow(ctx);
      const bridged = await runTvAcquisitionV2({
        title: ctx.title,
        mode: "type3",
        seasons: [
          {
            seasonNumber: patrol.season.seasonNumber,
            totalEpisodes: patrol.season.totalEpisodes,
            latestAiredEpisode: patrol.season.latestAiredEpisode,
            qualityPreference: patrol.season.qualityPreference,
            status: patrol.season.status,
          },
        ],
        categoryParentId: resolveTvCategoryParent(ctx),
        resourceProvider: ctx.resourceProvider,
        storage: ctx.storage,
        deadLinkStore: ctx.repository,
        model: ctx.model,
        workflowRunId: patrol.runId,
        // 实有 = the DB obtained marks; the need is aired − these (NOT a 115 scan).
        priorObtained: patrol.episodes
          .filter((episode) => episode.obtained)
          .map((episode) => episode.episodeCode),
        // 年守卫数据:巡检当季的全部播出日(syncSeasonMetadata 刚从 TMDB 刷新)。
        // 「1-10季」合集包把第九季(2025 日期)文件塞进 S10 任务的假入库靠它拒收。
        episodeAirDates: Object.fromEntries(
          patrol.episodes.flatMap((episode) =>
            episode.airDate === null
              ? []
              : [[episode.episodeCode, episode.airDate] as const],
          ),
        ),
        episodeNames: Object.fromEntries(
          patrol.episodes.flatMap((episode) =>
            !episode.title || /^Episode \d+$/.test(episode.title)
              ? []
              : [[episode.episodeCode, episode.title] as const],
          ),
        ),
        ...(episodeRules !== undefined ? { episodeRules } : {}),
        ...(Object.keys(promptLookup).length > 0 ? { promptOverrides: promptLookup } : {}),
        now,
        onProgress: progressAndTraceSink({
          repository: ctx.repository,
          workflowRunId: patrol.runId,
          neededHint: patrol.episodes.filter(
            (episode) => episode.airStatus === "aired" && !episode.obtained,
          ).length,
          storage: ctx.storage,
        }),
        ...capabilitySpread(ctx),
      });
      // ⑦ type3：单季记录（finishedAt 在跑后盖章；account/drive 归属拷自巡检侧）。
      await persistSingleSeason({
        kind: "type3_monitor",
        title: ctx.title,
        bridged,
        workflowRun: { id: patrol.runId, startedAt: patrol.startedAt, finishedAt: now() },
        repository: ctx.repository,
        ...(patrol.accountId ? { accountId: patrol.accountId } : {}),
        ...(patrol.connectedStorageId != null
          ? { connectedStorageId: patrol.connectedStorageId }
          : {}),
      });
      return { workflowStatus: bridged.status, result: bridged };
    }
  }
}
