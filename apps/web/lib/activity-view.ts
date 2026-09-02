import {
  landedSize,
  type AgentStep,
  type MediaType,
  type NotificationReportStatus,
  type WorkflowRepository,
  type WorkflowRunProgress,
  type WorkflowScope,
} from "@media-track/workflow";
import { distinctSeasons, seasonLabelText } from "./activity-season-label";

// Re-export the pure season-label helpers so existing server-side imports from
// this module keep working. The CANONICAL home is the runtime-free
// `activity-season-label.ts` — the "use client" activity-feed must import from
// there (not here), since this module pulls the Postgres-backed runtime.
export { distinctSeasons, seasonLabelText };

/** Per-step status for the expandable step list. Inferred from the run's overall
 *  state (see `inferStepStatuses`) — the trace itself records no outcome. */
export type ActivityStepStatus = "success" | "running" | "failed";

/** One agent tool-call step of a run, as shown in the activity row's expandable
 *  step list. A projection of the durable AgentStep trace plus the inferred
 *  status the UI renders (✅/⏳/❌). */
export interface ActivityStepView {
  ordinal: number;
  toolName: string;
  activity: string;
  phase: string;
  at: string;
  args: Record<string, unknown>;
  stepStatus: ActivityStepStatus;
  failReason?: string;
}

/** One title currently in the pipeline (queued or running). */
export interface ActivityActiveRun {
  runId: string;
  tmdbId: number;
  title: string;
  year: number | null;
  type: MediaType;
  posterPath: string | null;
  /** The snapshot's primary/placeholder season number (`snapshot.season`). May
   *  be a real number even for a whole-show ("全季") run, where it's just the
   *  scope's anchor season — NOT the full set of covered seasons. null only for
   *  movies / season-less snapshots. For display, prefer `seasonNumbers`. */
  seasonNumber: number | null;
  /** The distinct, sorted seasons the run actually covers, derived from its
   *  episode set. This is what the UI labels (e.g. "第 1/2/3/4 季"); a 全季 run
   *  spans many seasons even though `seasonNumber` is a single anchor value. */
  seasonNumbers: number[];
  status: "queued" | "running";
  /** 1-based position among queued items; null for the running one. */
  queuePosition: number | null;
  /** Aired-but-not-obtained episodes still needed. */
  missingCount: number;
  /** Live agent progress (running only). */
  progress: WorkflowRunProgress | null;
  /** The run's agent tool-call trace with inferred per-step status, shown in the
   *  expandable step list. [] while queued with no history, or on query failure. */
  steps: ActivityStepView[];
}

/** A recently-finished run. The client session-scopes 已完成 by matching these
 *  against the runIds it observed active (see ActivityView.recentCompleted). */
export interface ActivityCompletedItem {
  workflowRunId: string;
  title: string;
  seasonLabel: string | null;
  status: NotificationReportStatus;
  posterPath: string | null;
  /** "每集 约 410 MB" / "体积 1.4 GB"; null when unknown. */
  sizeText: string | null;
  createdAt: string;
  /** The run's agent tool-call trace with inferred per-step status, shown in the
   *  expandable step list. [] when the trace is empty or its query failed. */
  steps: ActivityStepView[];
}

export interface ActivityView {
  active: ActivityActiveRun[];
  /** Recently-finished runs (newest first). The CLIENT scopes 已完成 to this
   *  browser session by only showing the ones whose runId it observed active —
   *  robust to notification createdAt timing (which ≈ run-start, not finish). */
  recentCompleted: ActivityCompletedItem[];
}

/** Run-level state the step-status inference consumes. Decided by the caller
 *  from the run's workflow status (active) or report status (completed). */
export type StepRunState =
  | { kind: "success" } // run finished OK → every step ✅
  | { kind: "failed"; failReason: string } // terminal failure / retrying → last step ❌
  | { kind: "running" } // live run, still working → last step ⏳
  | { kind: "queued" }; // queued: no failure unless a stale trace survives

/** Report statuses that count as an overall SUCCESS (all steps ✅). `partial` is
 *  a genuine aired gap but the run itself completed — the steps all ran. */
const SUCCESS_REPORT_STATUSES: ReadonlySet<NotificationReportStatus> = new Set([
  "complete",
  "acquired",
  "airing",
  "partial",
  "no_coverage",
]);

/**
 * Infer each step's status from the run's overall state. Boundaries:
 *  - Empty trace → [] (nothing to show; the UI renders 暂无步骤记录).
 *  - Overall success → every step ✅.
 *  - failed/retrying → the LAST step ❌ (+failReason), earlier steps ✅ — the
 *    trace captures tool calls pre-execution, so everything before the crash ran.
 *  - running → the LAST step ⏳ (the live frontier), earlier steps ✅.
 *  - queued → fresh reservations have no trace → []. A leftover trace means a
 *    prior attempt failed and the auto-requeue is waiting → last step ❌.
 */
function inferStepStatuses(input: { runState: StepRunState; steps: AgentStep[] }): ActivityStepView[] {
  const { runState, steps } = input;
  if (steps.length === 0) {
    return [];
  }
  return steps.map((step, index) => {
    const isLast = index === steps.length - 1;
    let stepStatus: ActivityStepStatus = "success";
    let failReason: string | undefined;
    if (isLast) {
      if (runState.kind === "running") {
        stepStatus = "running";
      } else if (runState.kind === "failed") {
        stepStatus = "failed";
        failReason = runState.failReason;
      } else if (runState.kind === "queued") {
        stepStatus = "failed";
        failReason = "上一轮执行失败，等待重试";
      }
    }
    return {
      ordinal: step.ordinal,
      toolName: step.toolName,
      activity: step.activity,
      phase: step.phase,
      at: step.at,
      args: step.args,
      stepStatus,
      ...(failReason !== undefined ? { failReason } : {}),
    };
  });
}

/** Load one run's step trace and infer statuses. A query failure returns [] so a
 *  single broken trace can never take down the whole activity page. Shared by
 *  the activity page and the notifications feed (notifications render steps for
 *  runs that never appeared on the activity page, e.g. routine patrols). */
export async function runSteps(input: {
  repository: Pick<WorkflowRepository, "listAgentSteps">;
  runId: string;
  scope: WorkflowScope | undefined;
  runState: StepRunState;
}): Promise<ActivityStepView[]> {
  // series 全剧获取(consumption/stages/persist.ts persistSeriesSeasons)每季落一个
  // <uuid>_s<season> 子 run,通知挂在子 run 名下;但 agent_steps 始终记在无尾缀的
  // 主 run(progressAndTraceSink 用 claimed.runId)。直接用带尾缀 runId 查 agent_steps
  // 永远空 → UI「暂无步骤记录」。剥掉 _s 尾缀回退查主 run。
  const candidates = /_[a-z]\d+$/.test(input.runId)
    ? [input.runId, input.runId.replace(/_[a-z]\d+$/, "")]
    : [input.runId];
  for (const runId of candidates) {
    try {
      const steps = await input.repository.listAgentSteps(runId, input.scope);
      if (steps.length > 0) {
        return inferStepStatuses({ runState: input.runState, steps });
      }
    } catch {
      // 该候选查询失败 → 试下一个(剥尾缀回退)。
    }
  }
  return [];
}

/**
 * Assemble the activity page view: the live queue+running set, plus the recent
 * completed runs (the client decides which to show in 已完成 by matching against
 * runs it watched go active → done; history lives in 通知).
 */
export async function getActivityView(input: {
  repository: Pick<
    WorkflowRepository,
    | "listActiveWorkflowRuns"
    | "listNotifications"
    | "listTrackedSeasonStates"
    | "listAgentSteps"
  >;
  /** Scope the queue/notifications to one account (§7). Omitted → default. */
  accountId?: string;
  /** Tree model: scope queue/completed to one drive. Omitted/null → account-wide. */
  connectedStorageId?: string | null;
}): Promise<ActivityView> {
  const scope =
    input.accountId === undefined
      ? undefined
      : { accountId: input.accountId, connectedStorageId: input.connectedStorageId ?? null };
  const activeRuns = await input.repository.listActiveWorkflowRuns(scope);

  // Poster backfill source: older notifications predate report.posterPath, so a
  // completed item can lack a poster. The title is still tracked → source the
  // poster from it (by tmdbId, falling back to title name) so 已完成 shows the
  // real poster instead of the text fallback.
  const trackedStates = await input.repository.listTrackedSeasonStates(scope);
  const posterByTmdb = new Map<number, string>();
  const posterByName = new Map<string, string>();
  for (const state of trackedStates) {
    if (state.title.posterPath) {
      posterByTmdb.set(state.title.tmdbId, state.title.posterPath);
      posterByName.set(state.title.title, state.title.posterPath);
    }
  }

  // Queue positions: oldest-queued is position 1 (FIFO, matching the worker).
  const queuedOrder = activeRuns
    .filter((snapshot) => snapshot.workflowRun.status === "queued")
    .sort((a, b) => a.workflowRun.startedAt.localeCompare(b.workflowRun.startedAt))
    .map((snapshot) => snapshot.workflowRun.id);

  const active: ActivityActiveRun[] = await Promise.all(
    activeRuns.map(async (snapshot) => {
      const status = snapshot.workflowRun.status === "running" ? "running" : "queued";
      const missingCount = snapshot.episodes.filter(
        (episode) => episode.airStatus === "aired" && !episode.obtained,
      ).length;
      const queueIndex = queuedOrder.indexOf(snapshot.workflowRun.id);
      const runState: StepRunState = status === "running" ? { kind: "running" } : { kind: "queued" };
      return {
        runId: snapshot.workflowRun.id,
        tmdbId: snapshot.title.tmdbId,
        title: snapshot.title.title,
        year: snapshot.title.year ?? null,
        type: snapshot.title.type,
        posterPath: snapshot.title.posterPath ?? null,
        seasonNumber: snapshot.season.seasonNumber ?? null,
        seasonNumbers: distinctSeasons(snapshot.episodes),
        status,
        queuePosition: status === "queued" && queueIndex >= 0 ? queueIndex + 1 : null,
        missingCount,
        progress: snapshot.workflowRun.progress ?? null,
        steps: await runSteps({
          repository: input.repository,
          runId: snapshot.workflowRun.id,
          scope,
          runState,
        }),
      };
    }),
  );

  // recentCompleted = recent finished-run notifications (one per run), skipping
  // no-op patrol checks. NO time filter — the client session-scopes by matching
  // against the runIds it observed active (notification createdAt ≈ run-start, so
  // a server-side since filter wrongly drops runs the user opened the page after).
  // limit: 1000 = "all history" for personal use — the repository default would
  // truncate at 100 and silently hide older finished runs from the step list.
  const notifications = await input.repository.listNotifications({
    limit: 1000,
    ...(input.accountId
      ? { accountId: input.accountId, connectedStorageId: input.connectedStorageId ?? null }
      : {}),
  });
  const recentCompleted: ActivityCompletedItem[] = await Promise.all(
    notifications
      .filter(
        (notification) => notification.kind !== "already_current" && notification.report !== undefined,
      )
      .map(async (notification) => {
        const report = notification.report!;
        const size = landedSize(report);
        const posterPath =
          report.posterPath ??
          (report.tmdbId != null ? posterByTmdb.get(report.tmdbId) : undefined) ??
          posterByName.get(report.titleName) ??
          null;
        // Report status → step run-state. failed takes the report's own wording
        // (the honest reason, e.g. 转存失败:配额不足); retrying explains itself.
        let runState: StepRunState;
        if (SUCCESS_REPORT_STATUSES.has(report.status)) {
          runState = { kind: "success" };
        } else if (report.status === "retrying") {
          runState = { kind: "failed", failReason: "上一轮执行失败，自动重试中" };
        } else {
          runState = { kind: "failed", failReason: report.lines.join(" ") };
        }
        return {
          workflowRunId: notification.workflowRunId,
          title: report.titleName,
          seasonLabel: report.seasonLabel,
          status: report.status,
          posterPath,
          sizeText: size ? `${size.label} ${size.value}` : null,
          createdAt: notification.createdAt,
          steps: await runSteps({
            repository: input.repository,
            runId: notification.workflowRunId,
            scope,
            runState,
          }),
        };
      }),
  );

  return { active, recentCompleted };
}

/** Why `POST /api/activity/retry` refused. Shared by the route and the activity
 *  feed so both sides compare against the same literals — a hand-written string
 *  on either side would fall silently into the generic message. */
export type RetryRefusalReason = "kind_not_retriable" | "not_failed";
