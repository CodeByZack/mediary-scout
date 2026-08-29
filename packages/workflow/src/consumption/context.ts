import type { LanguageModel } from "ai";
import type {
  AcquisitionSeasonScope,
  EpisodeState,
  MediaTitle,
  MediaType,
  TrackedSeason,
  WorkflowKind,
} from "../domain.js";
import type { ResourceProvider, StorageExecutor } from "../ports.js";
import type { PersistedWorkflowRunSnapshot, WorkflowRepository } from "../repository.js";

/**
 * 任务消费流水线 · 上下文（design §3）。
 *
 * 认领成功后一次性解析全部依赖，构造 ConsumptionContext 一次；之后所有阶段
 * 函数只收它 + 上游阶段产物 —— 彻底终结 workflow-runtime → worker → runner-v2
 * → workflow-v2 → orchestrator 那条 4 层 `(x?{}:{})` 参数透传链。
 *
 * kind 差异只允许出现在 4 个收口点：认领（优先级表）、①目录父级、③need 形状、
 * ⑦落库口径 —— 其余阶段一律 kind-agnostic。
 */

/** 认领出来的队列 run 全量上下文（type2/type1/movie 认领侧构造）。 */
export interface ClaimedRun {
  runId: string;
  kind: WorkflowKind;
  startedAt: string;
  /** claimNextQueuedWorkflowRun 返回的完整快照（含 season/episodes/workflowRun）。
   *  设计稿 §3 的 episodes/titleRef 由此快照直接导出：type1 锁 run 收尾需要完整
   *  WorkflowRun 展开，保留原对象避免有损重建（偏差已记录，等价优先）。 */
  snapshot: PersistedWorkflowRunSnapshot;
  /** type1（series 整包）：从审计事件 series_init_queued.data.seasons 派生的逐季范围。 */
  seasonScopes: AcquisitionSeasonScope[];
}

/** 巡检直调上下文（步骤⑥启用：type3 巡检直调 consumeClaimedRun 时构造）。 */
export interface PatrolRun {
  runId: string;
  startedAt: string;
  /** 巡检侧同步过 aired/total 的当季记录。 */
  season: TrackedSeason;
  /** 当季全部集状态（pipeline type3 分支据此算 priorObtained 与 neededHint）。 */
  episodes: EpisodeState[];
  accountId: string;
  connectedStorageId: string | null;
}

/** 贯穿一次消费的全部依赖与能力注入。 */
export interface ConsumptionContext {
  /** type2_init | type1_package_init | type3_monitor | movie_init */
  kind: WorkflowKind;
  title: MediaTitle;
  /** 队列认领：认领到的 run。type3 巡检直调时为空。 */
  claimed?: ClaimedRun;
  /** 巡检直调（type3）：认领侧保留“不入队、直接 running”，预建 run 信息装这里。 */
  patrol?: PatrolRun;

  // ── 消费依赖 ──
  repository: WorkflowRepository;
  resourceProvider: ResourceProvider;
  model: LanguageModel;
  storage: StorageExecutor;

  // ── 注入能力 ──
  /** 存储品牌 id（注册表里已注册，如 "pan115"/"quark"）。 */
  storageProvider: string | undefined;
  /** 115 上 TV / 动漫 / Movies 父目录（对应 mediaType）。 */
  tvParentDirectoryId: string | undefined;
  animeParentDirectoryId: string | undefined;
  moviesParentDirectoryId: string | undefined;
  preferredLanguage: string | undefined;
  qualityPreference: "high" | "medium" | undefined;
  assrtToken: string | undefined;

  // ── 运行上下文 ──
  /** 从 claimed 快照拷出（防双认领后落库仍指向原 run 的 drive）。 */
  connectedStorageId: string | null;
  /** 墙钟（runner-v2 语义：finishedAt 在跑后盖章）。 */
  now?: () => string;
}

/** buildConsumptionContext 的依赖入参（= resolveWorkerDeps 合并后的账号级依赖）。 */
export interface ConsumptionDeps {
  repository: WorkflowRepository;
  resourceProvider: ResourceProvider;
  storage: StorageExecutor;
  model: LanguageModel;
  storageProvider: string | undefined;
  preferredLanguage: string | undefined;
  qualityPreference: "high" | "medium" | undefined;
  assrtToken: string | undefined;
  tvParentDirectoryId: string | undefined;
  animeParentDirectoryId: string | undefined;
  moviesParentDirectoryId: string | undefined;
}

/**
 * 认领成功后构造一次消费上下文（队列侧）。之后没有任何函数再收散装参数。
 * seasonScopes 的派生是纯读取（total 函数）——空值校验留在 pipeline 的 type1
 * 分支里按原位抛错（今天 worker 在 try 内检查，行为一致）。
 */
export function buildConsumptionContext(input: {
  kind: WorkflowKind;
  claimed: PersistedWorkflowRunSnapshot;
  deps: ConsumptionDeps;
  now?: () => string;
}): ConsumptionContext {
  const seasonScopes =
    input.kind === "type1_package_init"
      ? ((input.claimed.workflowRun.auditEvents.find(
          (event) => event.type === "series_init_queued",
        )?.data?.["seasons"] ?? []) as AcquisitionSeasonScope[])
      : [];
  return {
    kind: input.kind,
    title: input.claimed.title,
    claimed: {
      runId: input.claimed.workflowRun.id,
      kind: input.claimed.workflowRun.kind,
      startedAt: input.claimed.workflowRun.startedAt,
      snapshot: input.claimed,
      seasonScopes,
    },
    repository: input.deps.repository,
    resourceProvider: input.deps.resourceProvider,
    model: input.deps.model,
    storage: input.deps.storage,
    storageProvider: input.deps.storageProvider,
    tvParentDirectoryId: input.deps.tvParentDirectoryId,
    animeParentDirectoryId: input.deps.animeParentDirectoryId,
    moviesParentDirectoryId: input.deps.moviesParentDirectoryId,
    preferredLanguage: input.deps.preferredLanguage,
    qualityPreference: input.deps.qualityPreference,
    assrtToken: input.deps.assrtToken,
    connectedStorageId: input.claimed.connectedStorageId,
    ...(input.now === undefined ? {} : { now: input.now }),
  };
}

/**
 * 巡检直调消费上下文（决策 1 · 步骤⑥）：type3 巡检保留"不入队、直接
 * running"的预建 run 形态，认领侧信息装 PatrolRun；movie 巡检因 ⑦ 需要
 * 完整快照字段而走 buildConsumptionContext + 合成 claimed。
 */
export function buildPatrolConsumptionContext(input: {
  title: MediaTitle;
  patrol: PatrolRun;
  deps: ConsumptionDeps;
  now?: () => string;
}): ConsumptionContext {
  return {
    kind: "type3_monitor",
    title: input.title,
    patrol: input.patrol,
    repository: input.deps.repository,
    resourceProvider: input.deps.resourceProvider,
    model: input.deps.model,
    storage: input.deps.storage,
    storageProvider: input.deps.storageProvider,
    tvParentDirectoryId: input.deps.tvParentDirectoryId,
    animeParentDirectoryId: input.deps.animeParentDirectoryId,
    moviesParentDirectoryId: input.deps.moviesParentDirectoryId,
    preferredLanguage: input.deps.preferredLanguage,
    qualityPreference: input.deps.qualityPreference,
    assrtToken: input.deps.assrtToken,
    connectedStorageId: input.patrol.connectedStorageId,
    ...(input.now === undefined ? {} : { now: input.now }),
  };
}

/**
 * Pick the 115 landing parent for a title. Anime lands under its own parent
 * (when configured) so the 动漫 library shelf is a physically separate tree,
 * never intermixed with TV shows; everything else uses the default parent.
 * （原 worker.ts 私有函数，逐字搬迁 —— ①目录阶段的父级选择。）
 */
export function storageParentForTitle(
  title: { type: MediaType },
  storageParentDirectoryId: string | undefined,
  animeStorageParentDirectoryId: string | undefined,
): string | undefined {
  if (title.type === "anime" && animeStorageParentDirectoryId !== undefined) {
    return animeStorageParentDirectoryId;
  }
  return storageParentDirectoryId;
}

/**
 * The V2 directory lifecycle must verify-or-create the library category parent
 * (Movies/TV/Anime); a missing parent is a misconfiguration, not a silent
 * account-root fallback (fail loud — see acquisition-hard-details).
 * （原 worker.ts 私有函数，逐字搬迁。）
 */
export function requireCategoryParent(parent: string | undefined): string {
  if (parent === undefined || parent === "") {
    throw new Error(
      "MEDIA_TRACK_CATEGORY_PARENT_REQUIRED: a library category parent (Movies/TV/Anime) is required for directory verify-or-create",
    );
  }
  return parent;
}

/** ①目录阶段的 TV/动漫父级选择（type2/type1/type3 共用；movie 不走这里）。 */
export function resolveTvCategoryParent(ctx: ConsumptionContext): string {
  return requireCategoryParent(
    storageParentForTitle(ctx.title, ctx.tvParentDirectoryId, ctx.animeParentDirectoryId),
  );
}
