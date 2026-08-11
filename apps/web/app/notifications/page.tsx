import { connection } from "next/server";
import { Suspense } from "react";
import { Bell } from "lucide-react";
import type { NotificationEvent, NotificationReportStatus, WorkflowScope } from "@media-track/workflow";
import { landedSize } from "@media-track/workflow";
import { NotificationsSeenMarker } from "../../components/notifications-seen-marker";
import { DemoSessionNotifications } from "../../components/demo-session-notifications";
import { AppSidebar } from "../../components/app-sidebar";
import {
  ensureDemoSeeded,
  getCurrentAccountId,
  getWorkflowRepository,
  notificationWindowSince,
  resolveGlobalWorkspace,
} from "../../lib/workflow-runtime";
import { runSteps, type StepRunState } from "../../lib/activity-view";
import { NotificationCardWrapper } from "../../components/NotificationCardWrapper";
import { RoutineCardWrapper } from "../../components/RoutineCardWrapper";

// `searchParams` (the active drive `?w`) is a dynamic input + a DB read; reading it
// inside a Suspense boundary lets the static app shell prerender instead of the
// whole route blocking on it (cacheComponents "blocking-route"). Mirrors page.tsx.
export default function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ w?: string }>;
}) {
  return (
    <Suspense fallback={<NotificationsShell />}>
      <NotificationsSurface searchParams={searchParams} />
    </Suspense>
  );
}

function NotificationsShell() {
  return (
    <div className="app-shell">
      <AppSidebar active="notifications" />
      <main className="main product-main" aria-busy="true" />
    </div>
  );
}

async function NotificationsSurface({ searchParams }: { searchParams: Promise<{ w?: string }> }) {
  const { w } = await searchParams;
  const workspace = await resolveGlobalWorkspace(w);
  return (
    <div className="app-shell">
      <AppSidebar active="notifications" basePath={workspace.basePath} activeStorageId={workspace.activeStorageId} />
      <main className="main product-main">
        <NotificationsSeenMarker />
        <div className="section-heading library-heading">
          <div>
            <h1>通知</h1>
            <p>每天的资源获取与追踪日报</p>
          </div>
        </div>
        <DemoSessionNotifications />
        <Suspense fallback={<FeedSkeleton />}>
          <NotificationFeed connectedStorageId={workspace.connectedStorageId} />
        </Suspense>
      </main>
    </div>
  );
}

async function NotificationFeed({ connectedStorageId }: { connectedStorageId: string | null }) {
  // SQLite reads + "today/yesterday" labels are request-time work; declare it
  // so the PPR shell stays static and this hole streams per request.
  await connection();
  const repository = getWorkflowRepository();
  const accountId = await getCurrentAccountId();
  await ensureDemoSeeded(repository);
  const notifications = await repository.listNotifications({
    limit: 100,
    accountId,
    connectedStorageId,
    // Only the last 7 days — old notifications shouldn't pile up forever.
    since: notificationWindowSince(),
  });

  // Poster backfill: older notifications predate report.posterPath. Source the
  // poster from the still-tracked title (by tmdbId, then name) so cards show a
  // real poster instead of nothing.
  const trackedStates = await repository.listTrackedSeasonStates({ accountId, connectedStorageId });
  const posterByTmdb = new Map<number, string>();
  const posterByName = new Map<string, string>();
  for (const state of trackedStates) {
    if (state.title.posterPath) {
      posterByTmdb.set(state.title.tmdbId, state.title.posterPath);
      posterByName.set(state.title.title, state.title.posterPath);
    }
  }
  const fallbackPoster = (report: { posterPath?: string | null; tmdbId?: number; titleName: string }): string | null =>
    report.posterPath ??
    (report.tmdbId != null ? posterByTmdb.get(report.tmdbId) : undefined) ??
    posterByName.get(report.titleName) ??
    null;

  // Scope for step queries (account + drive).
  const scope: WorkflowScope | undefined =
    accountId === undefined ? undefined : { accountId, connectedStorageId };

  // Load steps for each notification that has a workflowRunId.
  const notificationsWithSteps = await Promise.all(
    notifications.map(async (notification) => {
      if (!notification.workflowRunId) {
        return { notification, steps: [] as Awaited<ReturnType<typeof runSteps>> };
      }
      const runState = notificationToRunState(notification);
      const steps = await runSteps({ repository, runId: notification.workflowRunId, scope, runState });
      return { notification, steps };
    }),
  );

  if (notificationsWithSteps.length === 0) {
    return (
      <div className="quiet-state">
        <Bell size={24} aria-hidden />
        <strong>还没有任何记录</strong>
        <span>发起获取或等待例行检查后，这里会按日期展示结果。</span>
      </div>
    );
  }

  // Build day groups using notifications with steps.
  const days = buildDaysWithSteps(notificationsWithSteps);
  return (
    <section className="feed">
      {days.map((day) => (
        <section className="feed-day" key={day.dateKey}>
          <header className="feed-day-header">
            <span className="feed-day-label">{day.dayLabel}</span>
            <span className="feed-day-summary">{day.summary}</span>
          </header>
          <div className="feed-cards">
            {day.blocks.map((block) =>
              block.type === "routine" ? (
                <RoutineCardWrapper key={block.id} items={block.items} time={block.time} itemsSteps={block.itemsSteps} />
              ) : (
                <NotificationCardWrapper
                  key={block.id}
                  notification={block.notification}
                  steps={block.steps}
                  size={block.notification.report ? (landedSize(block.notification.report) ?? null) : null}
                  fallbackPoster={block.notification.report ? fallbackPoster(block.notification.report) : null}
                />
              ),
            )}
          </div>
        </section>
      ))}
    </section>
  );
}

/** Map a notification's report status to the StepRunState used by runSteps. */
function notificationToRunState(notification: NotificationEvent): StepRunState {
  const report = notification.report;
  if (!report) {
    // No report (foreign work, old records) — treat as success (no failure info).
    return { kind: "success" };
  }
  if (notification.kind === "already_current") {
    // Routine patrol checks that found nothing new — all steps succeeded.
    return { kind: "success" };
  }
  const successStatuses: ReadonlySet<NotificationReportStatus> = new Set([
    "complete",
    "acquired",
    "airing",
    "partial",
    "no_coverage",
  ]);
  if (successStatuses.has(report.status)) {
    return { kind: "success" };
  }
  if (report.status === "retrying") {
    return { kind: "failed", failReason: "上一轮执行失败，自动重试中" };
  }
  // failed
  const reason = report.lines.length > 0 ? report.lines.join(" ") : "获取失败";
  return { kind: "failed", failReason: reason };
}

type NotificationWithSteps = {
  notification: NotificationEvent;
  steps: Awaited<ReturnType<typeof runSteps>>;
};

type Block =
  | { type: "event"; id: string; time: string; notification: NotificationEvent; steps: Awaited<ReturnType<typeof runSteps>> }
  | { type: "routine"; id: string; time: string; items: NotificationEvent[]; itemsSteps: Awaited<ReturnType<typeof runSteps>>[] };

interface DayGroup {
  dateKey: string;
  dayLabel: string;
  summary: string;
  blocks: Block[];
}

/**
 * Turn the flat notification log into day sections of separated, strictly
 * time-ordered cards:
 *  - every acquisition/tracking event becomes its own card;
 *  - duplicate same-day events for the same (title · season · kind) collapse to
 *    the latest one (re-running a sweep shouldn't show 校园之外 twice);
 *  - routine "nothing changed" checks fold into a single 例行巡检 card.
 */
function buildDaysWithSteps(notificationsWithSteps: NotificationWithSteps[]): DayGroup[] {
  const sorted = [...notificationsWithSteps].sort((a, b) => compareDesc(a.notification.createdAt, b.notification.createdAt));
  const dayMap = new Map<string, NotificationWithSteps[]>();
  for (const nws of sorted) {
    const key = dateKey(nws.notification.createdAt);
    const list = dayMap.get(key) ?? [];
    list.push(nws);
    dayMap.set(key, list);
  }

  return [...dayMap.entries()].map(([key, items]) => {
    const routineRaw = items.filter((item) => item.notification.kind === "already_current");
    const eventsRaw = items.filter((item) => item.notification.kind !== "already_current");

    // One card per show per day: the latest milestone wins regardless of kind,
    // so "开始追踪" in the morning and "追踪完成" at night don't both show — only
    // the freshest state of 校园之外 survives.
    const blocks: Block[] = [];
    const eventSubjects = new Set<string>();
    for (const nws of eventsRaw) {
      const subject = subjectKey(nws.notification);
      if (eventSubjects.has(subject)) continue; // sorted desc → first seen is latest
      eventSubjects.add(subject);
      blocks.push({ type: "event", id: nws.notification.id, time: nws.notification.createdAt, notification: nws.notification, steps: nws.steps });
    }

    // Routine checks only cover shows that didn't already get an event card today
    // (no point listing 抽烟 in 例行巡检 when its own card already states its state).
    const seenRoutine = new Set<string>();
    const routineItems: NotificationEvent[] = [];
    const routineItemsSteps: Awaited<ReturnType<typeof runSteps>>[] = [];
    for (const nws of routineRaw) {
      const subject = subjectKey(nws.notification);
      if (eventSubjects.has(subject) || seenRoutine.has(subject)) continue;
      seenRoutine.add(subject);
      routineItems.push(nws.notification);
      routineItemsSteps.push(nws.steps);
    }
    if (routineItems.length > 0) {
      blocks.push({ type: "routine", id: `routine_${key}`, time: routineItems[0]!.createdAt, items: routineItems, itemsSteps: routineItemsSteps });
    }

    blocks.sort((a, b) => compareDesc(a.time, b.time));
    return {
      dateKey: key,
      dayLabel: dayLabel(key),
      summary: daySummary(blocks),
      blocks,
    };
  });
}

/** Identity of the show a notification is about — kind-independent, so all of a
 *  day's events for one season collapse to its latest milestone. */
function subjectKey(notification: NotificationEvent): string {
  const name = notification.report?.titleName ?? notification.title;
  const season = notification.report?.seasonLabel ?? "";
  return `${name}|${season}`;
}

function compareDesc(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0;
}

function dateKey(iso: string): string {
  return new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
}

function dayLabel(key: string): string {
  const today = dateKey(new Date().toISOString());
  const yesterday = dateKey(new Date(Date.now() - 86_400_000).toISOString());
  if (key === today) return "今天";
  if (key === yesterday) return "昨天";
  const [year, month, day] = key.split("-");
  const thisYear = today.split("-")[0];
  return year === thisYear ? `${Number(month)}月${Number(day)}日` : `${year}年${Number(month)}月${Number(day)}日`;
}

function daySummary(blocks: Block[]): string {
  const eventBlocks = blocks.filter((block): block is Extract<Block, { type: "event" }> => block.type === "event");
  const newly = eventBlocks.reduce((sum, block) => sum + (block.notification.report?.newlyObtained.length ?? 0), 0);
  const noCoverage = eventBlocks.filter((block) => block.notification.kind === "no_coverage").length;
  const routine = blocks.find((block): block is Extract<Block, { type: "routine" }> => block.type === "routine");

  const parts: string[] = [`${eventBlocks.length} 项更新`];
  if (newly > 0) parts.push(`${newly} 集新增`);
  if (noCoverage > 0) parts.push(`${noCoverage} 项暂无资源`);
  if (routine) parts.push(`巡检 ${routine.items.length} 部`);
  return parts.join(" · ");
}

function FeedSkeleton() {
  return (
    <section className="feed">
      <div className="skeleton skeleton-heading" />
      <div className="skeleton skeleton-feed-card" />
      <div className="skeleton skeleton-feed-card" />
      <div className="skeleton skeleton-feed-card" />
    </section>
  );
}
