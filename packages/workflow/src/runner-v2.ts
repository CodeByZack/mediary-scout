import type { LanguageModel } from "ai";
import type {
  AcquisitionSeasonScope,
  EpisodeState,
  MediaTitle,
  MovieWorkflowResult,
  TrackedSeason,
  WorkflowKind,
  WorkflowRunMetadata,
} from "./domain.js";
import { runTvAcquisitionV2 } from "./acquisition-v2/run-tv-v2.js";
import type { BridgedV2Result } from "./acquisition-v2/workflow-v2-bridge.js";
import { runMovieAcquisitionV2 } from "./movie-workflow-v2.js";
// ★ ⑦落库与 run 观测管道已收口到 consumption/stages/persist.ts（同一实现，出口
// 名保留）；本文件过渡期仅剩"巡检宿主 + 旧 API 薄包装"，步骤⑥ 删除。
import {
  persistMovieRun,
  persistSeriesSeasons,
  persistSingleSeason,
  progressAndTraceSink,
  resolveNow,
} from "./consumption/stages/persist.js";
import type { ResourceProvider, StorageExecutor } from "./ports.js";
import type { WorkflowRepository } from "./repository.js";

/**
 * Phase 7d — production persist wrappers on the V2 engine. These mirror the old
 * runner.ts `*AndPersist` functions (same persisted record shapes so the
 * repository/frontend are unchanged) but the semantic loop is the sandboxed
 * strong agent (`model` injected) instead of the old weak AgentNodes. type2 /
 * series / type3 are the same resource-sync workflow; only the persistence
 * convention (single record vs per-season records, kind, trigger) differs.
 */

interface TvV2Common {
  title: MediaTitle;
  categoryParentId: string;
  resourceProvider: ResourceProvider;
  storage: StorageExecutor;
  model: LanguageModel;
  repository: WorkflowRepository;
  /** §7: owning account, stamped onto the persisted tracking record so a
   *  multi-user acquisition stays owned by the user who triggered it. */
  accountId?: string;
  /** Tree model: owning connected storage (drive/workspace), stamped alongside
   *  accountId so the record stays pinned to the drive it landed on. */
  connectedStorageId?: string | null;
  workflowRun: WorkflowRunMetadata;
  searchBudget?: number;
  maxSteps?: number;
  preferredLanguage?: string;
  /** Global quality preference ("high"/"medium"); undefined = 不限 (no guidance). */
  qualityPreference?: "high" | "medium";
  /** The run's drive brand ("pan115" | "quark") — selects brand-specific skill. */
  storageProvider?: string;
  /** assrt token (Settings → 字幕来源). Undefined = 字幕流程不触发。 */
  assrtToken?: string;
  /**
   * Wall clock for the run. Drives the engine's timestamps (including the
   * terminal notification's `createdAt`) AND the persisted `finishedAt`, which
   * is stamped *after* the acquisition awaits — so completion time reflects when
   * the run actually ended, not when it was claimed. Defaults to live time;
   * tests inject a deterministic clock. (See worker.ts: passing a precomputed
   * `finishedAt` as a call argument used to freeze it at run-start.)
   */
  now?: () => string;
}

function passthrough(input: TvV2Common): {
  searchBudget?: number;
  maxSteps?: number;
  preferredLanguage?: string;
  qualityPreference?: "high" | "medium";
  storageProvider?: string;
  assrtToken?: string;
} {
  return {
    ...(input.searchBudget === undefined ? {} : { searchBudget: input.searchBudget }),
    ...(input.maxSteps === undefined ? {} : { maxSteps: input.maxSteps }),
    ...(input.preferredLanguage === undefined ? {} : { preferredLanguage: input.preferredLanguage }),
    ...(input.qualityPreference === undefined ? {} : { qualityPreference: input.qualityPreference }),
    ...(input.storageProvider === undefined ? {} : { storageProvider: input.storageProvider }),
    ...(input.assrtToken === undefined ? {} : { assrtToken: input.assrtToken }),
  };
}

export async function runType2InitializationV2AndPersist(
  input: TvV2Common & { season: TrackedSeason },
): Promise<BridgedV2Result> {
  const now = resolveNow(input);
  const bridged = await runTvAcquisitionV2({
    title: input.title,
    mode: "type2",
    seasons: [
      {
        seasonNumber: input.season.seasonNumber,
        totalEpisodes: input.season.totalEpisodes,
        latestAiredEpisode: input.season.latestAiredEpisode,
        qualityPreference: input.season.qualityPreference,
        status: input.season.status,
      },
    ],
    categoryParentId: input.categoryParentId,
    resourceProvider: input.resourceProvider,
    storage: input.storage,
    deadLinkStore: input.repository,
    model: input.model,
    workflowRunId: input.workflowRun.id,
    now,
    onProgress: progressAndTraceSink({
      repository: input.repository,
      workflowRunId: input.workflowRun.id,
      neededHint: Math.min(input.season.latestAiredEpisode, input.season.totalEpisodes),
      storage: input.storage,
    }),
    ...passthrough(input),
  });

  await persistSingleSeason({
    kind: "type2_init",
    title: input.title,
    bridged,
    // Stamp finishedAt AFTER the run — it (and the notification createdAt) must
    // be the real completion time, not the claim time.
    workflowRun: { ...input.workflowRun, finishedAt: now() },
    repository: input.repository,
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.connectedStorageId != null ? { connectedStorageId: input.connectedStorageId } : {}),
  });
  return bridged;
}

export async function runType3MonitoringV2AndPersist(
  input: TvV2Common & { season: TrackedSeason; episodes: EpisodeState[] },
): Promise<BridgedV2Result> {
  const now = resolveNow(input);
  const bridged = await runTvAcquisitionV2({
    title: input.title,
    mode: "type3",
    seasons: [
      {
        seasonNumber: input.season.seasonNumber,
        totalEpisodes: input.season.totalEpisodes,
        latestAiredEpisode: input.season.latestAiredEpisode,
        qualityPreference: input.season.qualityPreference,
        status: input.season.status,
      },
    ],
    categoryParentId: input.categoryParentId,
    resourceProvider: input.resourceProvider,
    storage: input.storage,
    deadLinkStore: input.repository,
    model: input.model,
    workflowRunId: input.workflowRun.id,
    // 实有 = the DB obtained marks; the need is aired − these (NOT a 115 scan).
    priorObtained: input.episodes.filter((episode) => episode.obtained).map((episode) => episode.episodeCode),
    now,
    onProgress: progressAndTraceSink({
      repository: input.repository,
      workflowRunId: input.workflowRun.id,
      neededHint: input.episodes.filter((episode) => episode.airStatus === "aired" && !episode.obtained).length,
      storage: input.storage,
    }),
    ...passthrough(input),
  });

  await persistSingleSeason({
    kind: "type3_monitor",
    title: input.title,
    bridged,
    workflowRun: { ...input.workflowRun, finishedAt: now() },
    repository: input.repository,
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.connectedStorageId != null ? { connectedStorageId: input.connectedStorageId } : {}),
  });
  return bridged;
}

export async function runSeriesInitializationV2AndPersist(
  // `seasonQualityRecord` is the LEGACY per-season record string (e.g. "4K"),
  // distinct from TvV2Common.qualityPreference (the new high/medium agent
  // preference that drives qualityGuidance via passthrough). Renamed to avoid a
  // key collision on the intersection type.
  input: TvV2Common & { seasons: AcquisitionSeasonScope[]; seasonQualityRecord?: string },
): Promise<BridgedV2Result> {
  const quality = input.seasonQualityRecord ?? "4K";
  const now = resolveNow(input);
  const bridged = await runTvAcquisitionV2({
    title: input.title,
    mode: "series",
    seasons: input.seasons.map((season) => ({
      seasonNumber: season.seasonNumber,
      totalEpisodes: season.totalEpisodes,
      latestAiredEpisode: season.latestAiredEpisode,
      qualityPreference: quality,
    })),
    categoryParentId: input.categoryParentId,
    resourceProvider: input.resourceProvider,
    storage: input.storage,
    deadLinkStore: input.repository,
    model: input.model,
    workflowRunId: input.workflowRun.id,
    now,
    onProgress: progressAndTraceSink({
      repository: input.repository,
      workflowRunId: input.workflowRun.id,
      neededHint: input.seasons.reduce(
        (sum, season) => sum + Math.min(season.latestAiredEpisode, season.totalEpisodes),
        0,
      ),
      storage: input.storage,
    }),
    ...passthrough(input),
  });

  // Stamp completion AFTER the run; one finishedAt shared across all season
  // records (the title-level run finished once).
  // ⑦：逐季落库循环收口在 consumption/stages/persist.ts.persistSeriesSeasons。
  const finishedAt = now();
  await persistSeriesSeasons({
    title: input.title,
    bridged,
    workflowRun: input.workflowRun,
    finishedAt,
    repository: input.repository,
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.connectedStorageId != null
      ? { connectedStorageId: input.connectedStorageId }
      : {}),
  });
  return bridged;
}

export async function runMovieAcquisitionV2AndPersist(input: {
  title: MediaTitle;
  categoryParentId: string;
  resourceProvider: ResourceProvider;
  storage: StorageExecutor;
  model: LanguageModel;
  repository: WorkflowRepository;
  /** §7: owning account for the persisted record (see TvV2Common.accountId). */
  accountId?: string;
  /** Tree model: owning connected storage (see TvV2Common.connectedStorageId). */
  connectedStorageId?: string | null;
  workflowRun: WorkflowRunMetadata;
  searchBudget?: number;
  maxSteps?: number;
  preferredLanguage?: string;
  /** Global quality preference ("high"/"medium"); undefined = 不限 (no guidance). */
  qualityPreference?: "high" | "medium";
  /** The run's drive brand ("pan115" | "quark") — selects brand-specific skill. */
  storageProvider?: string;
  /** assrt token (Settings → 字幕来源). Undefined = 字幕流程不触发。 */
  assrtToken?: string;
  /** See TvV2Common.now — finishedAt is stamped post-run from this clock. */
  now?: () => string;
}): Promise<MovieWorkflowResult> {
  const now = resolveNow(input);
  const result = await runMovieAcquisitionV2({
    title: input.title,
    resourceProvider: input.resourceProvider,
    storage: input.storage,
    model: input.model,
    workflowRunId: input.workflowRun.id,
    moviesParentDirectoryId: input.categoryParentId,
    now,
    deadLinkStore: input.repository,
    onProgress: progressAndTraceSink({
      repository: input.repository,
      workflowRunId: input.workflowRun.id,
      neededHint: 1,
      storage: input.storage,
    }),
    ...(input.searchBudget === undefined ? {} : { searchBudget: input.searchBudget }),
    ...(input.maxSteps === undefined ? {} : { maxSteps: input.maxSteps }),
    ...(input.preferredLanguage === undefined ? {} : { preferredLanguage: input.preferredLanguage }),
    ...(input.qualityPreference === undefined ? {} : { qualityPreference: input.qualityPreference }),
    ...(input.storageProvider === undefined ? {} : { storageProvider: input.storageProvider }),
    ...(input.assrtToken === undefined ? {} : { assrtToken: input.assrtToken }),
  });

  // ⑦：movie 落库收口在 consumption/stages/persist.ts.persistMovieRun。
  await persistMovieRun({
    title: input.title,
    result,
    workflowRun: input.workflowRun,
    finishedAt: now(),
    repository: input.repository,
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.connectedStorageId != null
      ? { connectedStorageId: input.connectedStorageId }
      : {}),
  });
  return result;
}
