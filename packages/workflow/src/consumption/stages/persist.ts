import type {
  BridgedV2Result,
} from "../../acquisition-v2/workflow-v2-bridge.js";
import { makeProgressSink } from "../../acquisition-v2/progress-sink.js";
import {
  combineToolEventSinks,
  makeAgentTraceSink,
} from "../../acquisition-v2/agent-trace-sink.js";
import type { AgentToolEvent } from "../../acquisition-v2/activity.js";
import type {
  MediaTitle,
  MovieWorkflowResult,
  WorkflowKind,
  WorkflowRunMetadata,
} from "../../domain.js";
import type { StorageExecutor } from "../../ports.js";
import type {
  PersistedWorkflowRunSnapshot,
  WorkflowRepository,
} from "../../repository.js";

/**
 * 七阶段之 ⑦persistOutcome（design §2、§3、§7）：写-only、replay-safe。
 * kind 只在这层被 if（single record vs per-season records、通知口径、锁 run
 * 收尾）。record 形状与 runner-v2 今日逐字一致（repository/frontend 不变）。
 *
 * 同时收口 run 观测管道 progressAndTraceSink：活动页进度 + agent_steps 持久
 * trace 合并、互相隔离（一个坏不掉另一个）——它是写路径（落库 agent_steps），
 * 归入本层；由 ④ 装配时作为 onProgress 传入。
 */

/** See runner-v2.TvV2Common.now — finishedAt is stamped post-run from this clock. */
export function resolveNow(input: { now?: () => string }): () => string {
  return input.now ?? (() => new Date().toISOString());
}

/**
 * The run's onProgress: live activity progress (for the activity page) AND the
 * durable per-step trace (for post-mortem复盘), combined + isolated so one can't
 * break the other. `apiCallCount` surfaces the 115 budget burn per step (real 115
 * only; fakes omit it).
 * （原 runner-v2 私有函数，逐字搬迁。）
 */
export function progressAndTraceSink(input: {
  repository: WorkflowRepository;
  workflowRunId: string;
  neededHint: number;
  storage: StorageExecutor;
}): ReturnType<typeof combineToolEventSinks> {
  return combineToolEventSinks(
    makeProgressSink({
      repository: input.repository,
      workflowRunId: input.workflowRunId,
      neededHint: input.neededHint,
    }),
    makeAgentTraceSink({
      repository: input.repository,
      workflowRunId: input.workflowRunId,
      apiCallCount: () => input.storage.apiCallCount?.(),
    }),
  );
}

/** type2/type3 单季记录（原 runner-v2.persistSingleSeason 逐字搬迁）。 */
export async function persistSingleSeason(input: {
  kind: WorkflowKind;
  title: MediaTitle;
  bridged: BridgedV2Result;
  workflowRun: WorkflowRunMetadata;
  repository: WorkflowRepository;
  accountId?: string;
  connectedStorageId?: string | null;
}): Promise<void> {
  const seasonResult = input.bridged.seasons[0]!;
  await input.repository.saveWorkflowRunSnapshot({
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.connectedStorageId != null ? { connectedStorageId: input.connectedStorageId } : {}),
    title: input.title,
    season: seasonResult.season,
    workflowRun: {
      id: input.workflowRun.id,
      kind: input.kind,
      status: input.bridged.status,
      trackedSeasonId: seasonResult.season.id,
      startedAt: input.workflowRun.startedAt,
      finishedAt: input.workflowRun.finishedAt,
      auditEvents: input.bridged.auditEvents,
    },
    episodes: seasonResult.episodes,
    resourceSnapshots: input.bridged.resourceSnapshots,
    decisions: input.bridged.decisions,
    transferAttempts: input.bridged.transferAttempts,
    notifications: input.bridged.notifications,
  });
}

/**
 * type1：一季一条、id = `${runId}_s${n}`；资源证据/通知只挂第一条（title 级，
 * 不在 N 条里重复）。shared finishedAt（title 级 run 只结束一次）。
 * （原 runner-v2 series 落库循环逐字搬迁。）
 */
export async function persistSeriesSeasons(input: {
  title: MediaTitle;
  bridged: BridgedV2Result;
  workflowRun: WorkflowRunMetadata;
  finishedAt: string;
  repository: WorkflowRepository;
  accountId?: string;
  connectedStorageId?: string | null;
}): Promise<void> {
  for (const [index, seasonResult] of input.bridged.seasons.entries()) {
    const seasonRunId = `${input.workflowRun.id}_s${seasonResult.season.seasonNumber}`;
    await input.repository.saveWorkflowRunSnapshot({
      ...(input.accountId ? { accountId: input.accountId } : {}),
      ...(input.connectedStorageId != null ? { connectedStorageId: input.connectedStorageId } : {}),
      title: input.title,
      season: seasonResult.season,
      workflowRun: {
        id: seasonRunId,
        kind: "type1_package_init",
        status: input.bridged.status,
        trackedSeasonId: seasonResult.season.id,
        startedAt: input.workflowRun.startedAt,
        finishedAt: input.finishedAt,
        auditEvents: index === 0 ? input.bridged.auditEvents : [],
      },
      episodes: seasonResult.episodes,
      resourceSnapshots: index === 0 ? input.bridged.resourceSnapshots : [],
      decisions: index === 0 ? input.bridged.decisions : [],
      transferAttempts:
        index === 0
          ? input.bridged.transferAttempts.map((attempt) => ({ ...attempt, workflowRunId: seasonRunId }))
          : [],
      notifications:
        index === 0
          ? input.bridged.notifications.map((notification) => ({
              ...notification,
              id: notification.id.replace(input.workflowRun.id, seasonRunId),
              workflowRunId: seasonRunId,
            }))
          : [],
    });
  }
}

/**
 * type1 收尾：claimed 锁 run 自身的终态（它同时充当 season 1 的摘要记录——与
 * 已落库的 _s1 同 tracked season/episode 状态）。
 * （步骤① 自 worker 迁入 pipeline 的尾段，现收口于此。）
 */
export async function persistSeriesLockRun(input: {
  snapshot: PersistedWorkflowRunSnapshot;
  bridged: BridgedV2Result;
  repository: WorkflowRepository;
  finishedAt: string;
}): Promise<void> {
  const firstSeason = input.bridged.seasons[0];
  await input.repository.saveWorkflowRunSnapshot({
    accountId: input.snapshot.accountId,
    connectedStorageId: input.snapshot.connectedStorageId,
    title: input.snapshot.title,
    season: firstSeason?.season ?? input.snapshot.season,
    workflowRun: {
      ...input.snapshot.workflowRun,
      status: input.bridged.status,
      finishedAt: input.finishedAt,
      auditEvents: [
        ...input.snapshot.workflowRun.auditEvents,
        ...input.bridged.auditEvents,
      ],
    },
    episodes: firstSeason?.episodes ?? [],
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [],
  });
}

/** movie：单记录、kind=movie_init、集状态由引擎自带（原 runner-v2 movie 落库段逐字搬迁）。 */
export async function persistMovieRun(input: {
  title: MediaTitle;
  result: MovieWorkflowResult;
  workflowRun: WorkflowRunMetadata;
  finishedAt: string;
  repository: WorkflowRepository;
  accountId?: string;
  connectedStorageId?: string | null;
}): Promise<void> {
  await input.repository.saveWorkflowRunSnapshot({
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.connectedStorageId != null ? { connectedStorageId: input.connectedStorageId } : {}),
    title: input.title,
    season: input.result.season,
    workflowRun: {
      id: input.workflowRun.id,
      kind: "movie_init",
      status: input.result.status,
      trackedSeasonId: input.result.season.id,
      startedAt: input.workflowRun.startedAt,
      finishedAt: input.finishedAt,
      auditEvents: input.result.auditEvents,
    },
    episodes: input.result.episodes,
    resourceSnapshots: input.result.resourceSnapshots,
    decisions: input.result.decisions,
    transferAttempts: input.result.transferAttempts,
    notifications: input.result.notifications,
  });
}
