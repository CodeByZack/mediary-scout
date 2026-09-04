import type { LanguageModel } from "ai";
import type { EpisodeParseRules } from "../../episode-code.js";
import type { AuditEvent } from "../../domain.js";
import type { ResourceProvider, StorageExecutor } from "../../ports.js";
import type { AcquisitionDirectories } from "../../acquisition-v2/directory-lifecycle.js";
import type { DeadLinkStore } from "../../acquisition-v2/dead-links.js";
import type { AgentToolEvent } from "../../acquisition-v2/activity.js";
import {
  runAcquisitionV2,
  type AcquisitionV2Outcome,
} from "../../acquisition-v2/orchestrator.js";
import type { SearchProfile } from "../../acquisition-v2/search-profile.js";
import { readLandedSizeStage } from "./directories.js";
import { reconcileNeed, type NeedSeason, type NeedSnapshot } from "./need.js";

/**
 * 七阶段之 ④runAcquisition 核心（design §2、§7 consumption/stages/acquire.ts）。
 *
 * ★ 唯一烧配额/token 的阶段：真实搜索（预搜+别名兜底重搜）、真实转存、全部 AI
 * 升级点都发生在 orchestrator → fast path 内部；①③⑤⑥⑦ 均 replay-safe。
 * 本阶段做"装配段"收口（原 workflow-v2.ts 的 orchestrator 调用 + spread 长链），
 * orchestrator 本体（组合根：TaskSandbox/primeRawSnapshot/字幕预热三闸门/tv 分发）
 * 作为器件不动。⑤⑥ 紧跟其后（对账 + 体积），与今天在 workflow-v2 闭包内的顺序
 * 逐字一致 —— 顺序即语义（115 调用预算、通知体积读取时机）。
 */

export interface V2WorkflowSeason {
  seasonNumber: number;
  /** Aired up to this episode (should-exist = E01..latestAiredEpisode). */
  latestAiredEpisode: number;
}

export interface RunAcquisitionV2WorkflowRequest {
  provider: ResourceProvider;
  executor: StorageExecutor;
  model: LanguageModel;
  workflowRunId: string;
  title: { name: string; year: number; aliases: string[]; tmdbId: number };
  /** Library category parent (Movies/TV/Anime), chosen by title.type upstream. */
  categoryParentId: string;
  seasons: V2WorkflowSeason[];
  qualityPreference: string;
  /** 实有 = the DB obtained marks for this title (the agent's prior markObtained).
   *  Empty for a first acquisition; the type-3 patrol passes the DB's obtained
   *  episode codes so the need = aired − 实有 (NOT a 115 scan). */
  priorObtained?: string[];
  /** TMDB 各集播出日(SxxExx → "YYYY-MM-DD")。type3 巡检带当季 episode_states 的
   *  播出日进 fast path,启用年守卫;缺省 = 守卫惰性(旧语义)。issue #21 同族防线。 */
  episodeAirDates?: Record<string, string>;
  /** TMDB 各集原始 name(SxxExx → "Episode 10 (Part 1)")。综艺「第N期上/下 ↔
   *  Episode N (Part 1/2)」锚定数据(2026-08-31 地球超新鲜案);缺省 = 无 Part 锚定。 */
  episodeNames?: Record<string, string>;
  /** issue #44: 可配置集数解析规则(UI 编辑后注入)。缺省 = 内置正则。 */
  episodeRules?: EpisodeParseRules;
  searchBudget?: number;
  maxSteps?: number;
  preferredLanguage?: string;
  /** TMDB origin_country of the title — when it includes CN the TV/anime prompt skips
   *  the 中文 subtitle floor (国产剧/动漫 natively Chinese-spoken). */
  originCountries?: string[];
  searchHints?: string;
  qualityGuidance?: string;
  /** The task's fine-grained search profile — enables the anime taboo-keyword
   *  validator (warnings only, never blocking). 病2b。 */
  searchProfile?: SearchProfile;
  /** The run's drive brand ("pan115" | "quark") — selects brand-specific skill. */
  storageProvider?: string;
  /** assrt token (Settings → 字幕来源). Undefined = 字幕流程不触发。 */
  assrtToken?: string;
  deadLinkStore?: DeadLinkStore;
  onProgress?: (event: AgentToolEvent) => void;
}

export interface RunAcquisitionV2WorkflowResult {
  directories: AcquisitionDirectories;
  /** The missing set computed before the agent ran. */
  missingBefore: string[];
  outcome: AcquisitionV2Outcome;
  agentText: string;
  /** Re-synced from real storage after the agent: what is still missing / obtained. */
  stillMissing: string[];
  obtained: string[];
  providerAhead: string[];
  /** Real landed video files across the season dirs (best-effort, post-run); fuels
   *  the notification's true per-episode size. Absent when the read failed/empty. */
  landedFileCount?: number;
  landedBytes?: number;
  auditEvents: AuditEvent[];
}

export interface TvAcquisitionCoreInput {
  request: RunAcquisitionV2WorkflowRequest;
  directories: AcquisitionDirectories;
  /** ③computeNeed 产物（missing 非空才会进本阶段 —— 判空 no-op 在调用方早退）。 */
  need: NeedSnapshot;
  seasonsForSync: NeedSeason[];
  priorObtained: string[];
}

/** ④(核心) → ⑤ → ⑥ 的连段（从 workflow-v2 闭包逐字搬迁，顺序与语义不变）。 */
export async function runAcquisitionCoreStage(
  input: TvAcquisitionCoreInput,
): Promise<RunAcquisitionV2WorkflowResult> {
  const { request, directories, need, seasonsForSync, priorObtained } = input;

  // Run the strong TV/anime agent over the sandbox.
  const v2 = await runAcquisitionV2({
    provider: request.provider,
    executor: request.executor,
    model: request.model,
    workflowRunId: request.workflowRunId,
    target: {
      kind: "tv",
      title: request.title.name,
      aliases: request.title.aliases,
      seasons: request.seasons.map((season) => season.seasonNumber),
      missingEpisodes: need.missing,
      ...(request.episodeAirDates === undefined ? {} : { episodeAirDates: request.episodeAirDates }),
          ...(request.episodeNames === undefined ? {} : { episodeNames: request.episodeNames }),
      qualityPreference: request.qualityPreference,
    },
    stagingDirectoryId: directories.stagingDirectoryId,
    targetSeasonDirectoryIds: directories.seasonDirectoryIds,
    ...(request.searchBudget === undefined ? {} : { searchBudget: request.searchBudget }),
    ...(request.maxSteps === undefined ? {} : { maxSteps: request.maxSteps }),
    ...(request.preferredLanguage === undefined ? {} : { preferredLanguage: request.preferredLanguage }),
    ...(request.originCountries === undefined ? {} : { originCountries: request.originCountries }),
    ...(request.searchHints === undefined ? {} : { searchHints: request.searchHints }),
    ...(request.qualityGuidance === undefined ? {} : { qualityGuidance: request.qualityGuidance }),
    ...(request.searchProfile === undefined ? {} : { searchProfile: request.searchProfile }),
    ...(request.storageProvider === undefined ? {} : { storageProvider: request.storageProvider }),
    ...(request.assrtToken === undefined ? {} : { assrtToken: request.assrtToken }),
    ...(request.deadLinkStore ? { deadLinkStore: request.deadLinkStore } : {}),
    ...(request.onProgress ? { onProgress: request.onProgress } : {}),
    ...(request.episodeRules === undefined ? {} : { episodeRules: request.episodeRules }),
  });

  // Reconcile from the AGENT'S coverage (its markObtained), NOT a 115 re-scan:
  // 实有 after = prior DB marks ∪ what the agent marked this run (§1.13/§7b).
  const after = reconcileNeed({
    seasons: seasonsForSync,
    priorObtained,
    newlyObtained: v2.coverage.obtained,
  });

  // Best-effort real landed size for the notification (true per-episode bytes,
  // not a claimed quality). Reads AFTER the acquisition succeeded; on the heavy
  // run where the 115 call budget is spent this returns undefined rather than
  // throwing, so the size is simply omitted — never failing a good run.
  const landed = await readLandedSizeStage(request.executor, directories.seasonDirectoryIds);

  return {
    directories,
    missingBefore: need.missing,
    outcome: v2.outcome,
    agentText: v2.text,
    stillMissing: after.missing,
    obtained: after.obtained,
    providerAhead: after.providerAhead,
    auditEvents: v2.auditEvents,
    ...(landed ? { landedFileCount: landed.fileCount, landedBytes: landed.totalBytes } : {}),
  };
}
