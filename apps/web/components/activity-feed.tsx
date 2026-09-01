"use client";

import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import Link from "next/link";
import { CheckCircle2, ChevronDown, ChevronRight, Clock3, Loader2, RotateCcw, TriangleAlert, X } from "lucide-react";
import { showHref } from "@media-track/workflow/scope";
import type {
  ActivityActiveRun,
  ActivityCompletedItem,
  ActivityStepView,
  ActivityView,
  RetryRefusalReason,
} from "../lib/activity-view";
import { seasonLabelText } from "../lib/activity-season-label";
import {
  stepArgsText,
  stepDetailView,
  type StepDetailView as StepEvidenceView,
} from "../lib/step-args-text";
import { groupStepsIntoRounds, hasRoundStructure, roundVerdict, type StepRoundCard } from "../lib/step-rounds";
import { isDemoModeClient } from "../lib/demo-mode";
import { demoCompletedItems, demoInProgressActivityItems } from "../lib/demo-session";
import { useDemoAcquisitions, useDemoInProgress } from "../lib/use-demo-session";

const POLL_MS = 2600;
const POSTER = "https://image.tmdb.org/t/p/w185";

export function ActivityFeed({ storageId }: { storageId?: string | undefined }) {
  // 已完成 is session-scoped by OBSERVATION: the runIds this browser saw active.
  // Robust to notification createdAt timing (a since-filter wrongly dropped runs
  // the user opened the page after — createdAt ≈ run-start, not finish).
  const seenActive = useRef<Set<string>>(new Set());
  const [view, setView] = useState<ActivityView>({ active: [], recentCompleted: [] });

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const url = storageId ? `/api/activity?w=${encodeURIComponent(storageId)}` : "/api/activity";
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as ActivityView;
        for (const run of data.active) {
          seenActive.current.add(run.runId);
        }
        if (alive) setView(data);
      } catch {
        // transient — keep the last view, retry next tick
      }
    };
    void poll(); // immediate first load (the page renders this client component in the static shell)
    const id = setInterval(() => void poll(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [storageId]);

  const running = view.active.filter((run) => run.status === "running");
  const queued = view.active
    .filter((run) => run.status === "queued")
    .sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0));
  // Only show completions for runs THIS session watched go active → done.
  const completed = view.recentCompleted.filter((item) => seenActive.current.has(item.workflowRunId));
  // Demo: acquisitions are client-only (no DB run) → surface this session's
  // acquired titles as completed items, and in-progress playbacks as live 获取中
  // rows, so the activity page reflects them like production.
  const demoAcq = useDemoAcquisitions();
  const isDemo = isDemoModeClient();
  const demoDone = isDemo ? demoCompletedItems(demoAcq) : [];
  const demoActive = demoInProgressActivityItems(useDemoInProgress());
  const allCompleted = [...demoDone, ...completed];

  return (
    <div className="activity">
      <section className="act-section">
        <div className="act-section-head act-section-head-static">获取中</div>
        {running.length === 0 && demoActive.length === 0 ? (
          <p className="act-empty">当前没有正在处理的任务。</p>
        ) : (
          <>
            {demoActive.map((item) => (
              <DemoRunningRow item={item} key={item.id} />
            ))}
            {running.map((run) => (
              <RunningRow run={run} storageId={storageId} key={run.runId} />
            ))}
          </>
        )}
      </section>

      <CollapsibleSection title="排队中" count={queued.length} defaultOpen>
        {queued.length === 0 ? (
          <p className="act-empty">没有排队的任务。</p>
        ) : (
          queued.map((run) => <QueuedRow run={run} key={run.runId} />)
        )}
      </CollapsibleSection>

      <CollapsibleSection title="已完成" count={allCompleted.length} note="仅本次浏览" defaultOpen>
        {allCompleted.length === 0 ? (
          <p className="act-empty">本次浏览还没有完成的任务，历史可在通知查看。</p>
        ) : (
          allCompleted.map((item) => <CompletedRow item={item} key={item.workflowRunId} />)
        )}
      </CollapsibleSection>
    </div>
  );
}

function poster(posterPath: string | null, title: string, tone: string) {
  return posterPath ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img className="act-poster" src={`${POSTER}${posterPath}`} alt="" loading="lazy" />
  ) : (
    <span className={`act-poster act-poster-fallback tone-${tone}`}>{title.slice(0, 2)}</span>
  );
}

function seasonLabel(run: ActivityActiveRun): string {
  return seasonLabelText(run.type, run.seasonNumbers ?? [], run.seasonNumber);
}

/** Chevron affordance on an expandable row header (rotates with open state). */
export function ExpandChevron({ open }: { open: boolean }) {
  return open ? (
    <ChevronDown size={15} className="act-row-chevron" aria-hidden />
  ) : (
    <ChevronRight size={15} className="act-row-chevron" aria-hidden />
  );
}


export function StepStatusIcon({ status }: { status: ActivityStepView["stepStatus"] }) {
  if (status === "running") {
    return <Clock3 size={13} className="act-step-icon act-step-running" aria-hidden />;
  }
  if (status === "failed") {
    return <TriangleAlert size={13} className="act-step-icon act-step-failed" aria-hidden />;
  }
  return <CheckCircle2 size={13} className="act-step-icon act-step-success" aria-hidden />;
}

/** The expandable step list under a row header: one line per agent tool call,
 *  status icon + 中文 activity + toolName + localized time + key args. */
/** 单条步骤行(扁平列表内)。 */
function StepRow({ step }: { step: ActivityStepView }) {
  const detail = stepDetailView(step);
  const argsText = stepArgsText(step);
  return (
    <div className="act-step">
      <StepStatusIcon status={step.stepStatus} />
      <div className="act-step-main">
        <div className="act-step-head">
          <span className="act-step-activity">{step.activity}</span>
          <span className="act-step-tool">{step.toolName}</span>
          <span className="act-step-at">{new Date(step.at).toLocaleString("zh-CN")}</span>
        </div>
        {step.failReason ? <div className="act-step-fail">{step.failReason}</div> : null}
        {detail ? <StepEvidence detail={detail} /> : argsText ? <div className="act-step-args">{argsText}</div> : null}
      </div>
    </div>
  );
}

/** 轮次卡片:默认折叠,点开展开该轮的全部步骤。issue #29。 */
function RoundCard({ card }: { card: StepRoundCard }) {
  const [open, setOpen] = useState(false);
  // B5:卡头点击需阻止冒泡——RoutineCardWrapper 的 <li onClick> 会包住整个步骤区,
  // 不 stop 的话点卡片会先折叠整条巡检项、卡片被卸载。
  const toggle = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    setOpen((v) => !v);
  };
  if (card.kind !== "transfer") {
    return (
      <div className={"act-round act-round-" + card.kind}>
        <div className="act-round-head act-round-toggle" role="button" tabIndex={0} aria-expanded={open} onClick={toggle} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(e as unknown as ReactMouseEvent<HTMLDivElement>); } }}>
          <span className="act-round-title">{card.heading}</span>
          <span className="act-round-count">{card.steps.length} 步</span>
          <ExpandChevron open={open} />
        </div>
        {open ? <div className="act-round-body">{card.steps.map((s) => <StepRow key={s.ordinal} step={s} />)}</div> : null}
      </div>
    );
  }
  // B1:判定三态(单一事实来源 roundVerdict)——pass=digest 通过或最终归位;
  // fail=未通过且未归位;unknown=args 被塌缩。
  const verdict = roundVerdict(card);
  const digest = card.steps.find((s) => s.toolName === "stagingDigest");
  const videoCount = typeof digest?.args?.["videoCount"] === "number" ? digest.args["videoCount"] : undefined;
  return (
    <div className={"act-round act-round-transfer" + (verdict === "pass" ? " act-round-pass" : verdict === "fail" ? " act-round-fail" : "")}>
      <div className="act-round-head act-round-toggle" role="button" tabIndex={0} aria-expanded={open} onClick={toggle} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(e as unknown as ReactMouseEvent<HTMLDivElement>); } }}>
        <span className="act-round-title">{card.heading}</span>
        {videoCount !== undefined ? <span className="act-round-meta">{videoCount} 个文件</span> : null}
        {verdict === "pass" ? <span className="act-round-badge act-round-badge-pass">✓ 命中</span> : verdict === "fail" ? <span className="act-round-badge act-round-badge-fail">✗ 未命中</span> : verdict === "unknown" ? <span className="act-round-badge act-round-badge-unknown">? 判定未知</span> : null}
        <ExpandChevron open={open} />
      </div>
      {open ? <div className="act-round-body">{card.steps.map((s) => <StepRow key={s.ordinal} step={s} />)}</div> : null}
    </div>
  );
}

/** 汇总「轮次卡片化」的步骤列表:有结构化 round 的转存步骤 → 卡片;纯老数据 → 扁平。 */
export function StepList({ steps }: { steps: ActivityStepView[] }) {
  if (steps.length === 0) {
    return (
      <div className="act-step-list">
        <p className="act-steps-empty">暂无步骤记录</p>
      </div>
    );
  }
  const hasRounds = hasRoundStructure(steps);
  if (!hasRounds) {
    // 老数据:无轮次信息,保持原有扁平列表(行为不变)。
    return (
      <div className="act-step-list">
        {steps.map((step) => <StepRow key={step.ordinal} step={step} />)}
      </div>
    );
  }
  const cards = groupStepsIntoRounds(steps);
  return (
    <div className="act-round-list">
      {cards.map((card) => <RoundCard key={String(card.round) + "-" + card.kind + "-" + card.steps[0]?.ordinal} card={card} />)}
    </div>
  );
}
function StepEvidence({ detail }: { detail: NonNullable<StepEvidenceView> }) {
  if (detail.kind === "files") {
    return (
      <ul className="act-step-evidence">
        {detail.rows.map((row, index) => (
          <li className="act-ev-file" key={index}>
            {row}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="act-step-evidence">
      {detail.keyword ? <div className="act-ev-keyword">关键词「{detail.keyword}」</div> : null}
      {detail.rows.map((row, index) => (
        <div className="act-ev-row" key={index}>
          {row.grade ? (
            <span className={`act-ev-grade act-ev-${row.grade.toLowerCase()}`}>{row.grade}</span>
          ) : null}
          <span className="act-ev-title" title={row.title}>
            {row.title}
          </span>
          {row.reasons.length > 0 ? (
            <span className="act-ev-reason" title={row.reasons.join("；")}>
              {row.reasons.join("；")}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function RunningRow({ run, storageId }: { run: ActivityActiveRun; storageId?: string | undefined }) {
  const [open, setOpen] = useState(false);
  const percent = Math.max(3, Math.min(100, run.progress?.percent ?? 3));
  const headline =
    run.progress?.needed && run.progress.needed > 0
      ? `已确认 ${run.progress.obtained ?? 0} / ${run.progress.needed} 集`
      : null;
  return (
    <div className="act-row act-row-active act-row-expandable">
      <div className="act-row-toggle" onClick={() => setOpen((value) => !value)}>
        <Link
          className="act-poster-link"
          href={showHref(run.tmdbId, "library", storageId, run.type)}
          onClick={(event) => event.stopPropagation()}
        >
          {poster(run.posterPath, run.title, "info")}
        </Link>
        <div className="act-row-body">
          <div className="act-row-head">
            <strong>{run.title}</strong>
            {seasonLabel(run) ? <span className="act-sub">{seasonLabel(run)}</span> : null}
            {headline ? <span className="act-frac">{headline}</span> : null}
          </div>
          <div className="act-bar">
            <div className="act-bar-fill" style={{ width: `${percent}%` }} />
          </div>
          <div className="act-ticker-row">
            <Loader2 size={14} className="act-spin" aria-hidden />
            <Ticker text={run.progress?.activity ?? "正在准备…"} />
          </div>
        </div>
        <ExpandChevron open={open} />
      </div>
      {open ? <StepList steps={run.steps} /> : null}
    </div>
  );
}

function Ticker({ text }: { text: string }) {
  // Two absolutely-stacked lines: the outgoing slides up & out, the incoming slides
  // up into place. On collapse we keep ONLY the incoming — its key is stable, so
  // React preserves the element (no remount) and it's already at rest (translateY
  // 0 = the is-in end state) → seamless, no "jump in from the top" flash.
  const idRef = useRef(0);
  const [lines, setLines] = useState<{ id: number; text: string }[]>([{ id: 0, text }]);
  const prev = useRef(text);

  useEffect(() => {
    if (text === prev.current) {
      return;
    }
    prev.current = text;
    idRef.current += 1;
    const id = idRef.current;
    setLines((current) => {
      const outgoing = current[current.length - 1];
      return outgoing ? [outgoing, { id, text }] : [{ id, text }];
    });
    const timer = setTimeout(() => setLines([{ id, text }]), 380);
    return () => clearTimeout(timer);
  }, [text]);

  return (
    <div className="act-ticker" aria-live="polite">
      {lines.map((line, index) => (
        <div
          key={line.id}
          className={`act-ticker-line${lines.length > 1 ? (index === 0 ? " is-out" : " is-in") : ""}`}
        >
          {line.text}
        </div>
      ))}
    </div>
  );
}

type DemoActivityItem = ReturnType<typeof demoInProgressActivityItems>[number];

/** Demo-only 获取中 row: clock-driven progress, no DB run (not a link). Mirrors
 *  RunningRow's poster + progress bar + step layout. */
function DemoRunningRow({ item }: { item: DemoActivityItem }) {
  const percent = Math.max(3, Math.min(100, item.progress));
  return (
    <div className="act-row act-row-active">
      {poster(item.posterPath, item.title, "info")}
      <div className="act-row-body">
        <div className="act-row-head">
          <strong>{item.title}</strong>
        </div>
        <div className="act-bar">
          <div className="act-bar-fill" style={{ width: `${percent}%` }} />
        </div>
        <div className="act-ticker-row">
          <Loader2 size={14} className="act-spin" aria-hidden />
          <Ticker text={item.step} />
        </div>
      </div>
    </div>
  );
}

function QueuedRow({ run }: { run: ActivityActiveRun }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="act-row act-row-queued act-row-expandable">
      <div className="act-row-toggle" onClick={() => setOpen((value) => !value)}>
        {poster(run.posterPath, run.title, "muted")}
        <div className="act-row-body act-row-inline">
          <strong>{run.title}</strong>
          {seasonLabel(run) ? <span className="act-sub">{seasonLabel(run)}</span> : null}
          <span className="act-pill">
            <Clock3 size={12} aria-hidden />第 {run.queuePosition} 位{run.missingCount > 0 ? ` · 缺 ${run.missingCount} 集` : ""}
          </span>
          <CancelButton runId={run.runId} title={run.title} />
        </div>
        <ExpandChevron open={open} />
      </div>
      {open ? <StepList steps={run.steps} /> : null}
    </div>
  );
}

function completedPillLabel(status: ActivityCompletedItem["status"]): string {
  switch (status) {
    case "no_coverage":
      return "暂无资源";
    case "partial":
      return "部分入库";
    case "failed":
      return "获取失败";
    case "retrying":
      return "重试中…";
    default:
      return "已入库";
  }
}

function CompletedRow({ item }: { item: ActivityCompletedItem }) {
  const [open, setOpen] = useState(false);
  const ok = item.status === "complete" || item.status === "acquired" || item.status === "airing";
  const failed = item.status === "failed";
  return (
    <div className="act-row act-row-done act-row-expandable">
      <div className="act-row-toggle" onClick={() => setOpen((value) => !value)}>
        {poster(item.posterPath, item.title, ok ? "success" : "warn")}
        <div className="act-row-body act-row-inline">
          <strong>{item.title}</strong>
          {item.seasonLabel ? <span className="act-sub">{item.seasonLabel}</span> : null}
          <span className={`act-pill ${ok ? "tone-success" : "tone-warn"}`}>
            {ok ? <CheckCircle2 size={12} aria-hidden /> : <TriangleAlert size={12} aria-hidden />}
            {completedPillLabel(item.status)}
          </span>
          {item.sizeText ? <span className="act-sub">{item.sizeText}</span> : null}
          {failed ? <RetryButton runId={item.workflowRunId} title={item.title} /> : null}
        </div>
        <ExpandChevron open={open} />
      </div>
      {open ? <StepList steps={item.steps} /> : null}
    </div>
  );
}

function RetryButton({ runId, title }: { runId: string; title: string }) {
  const [busy, setBusy] = useState(false);

  const retry = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/activity/retry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId }),
      });
      const result = (await res.json()) as {
        status?: string;
        reason?: RetryRefusalReason;
      };
      if (result.status !== "retried") {
        // Distinguish the two refusal causes. "可能已在处理" is wrong — and
        // misleading — for a patrol run: patrols are not queue-claimable, so they
        // can never be retried this way; the user should re-trigger a patrol.
        window.alert(
          result.reason === "kind_not_retriable"
            ? `「${title}」是巡检任务，不能单独重试。请在设置里触发一次巡检，或等待下一次自动巡检。`
            : `「${title}」无法重试（可能已在处理）。`,
        );
      }
      // The next poll reconciles: the run re-appears in 排队中/获取中.
    } catch {
      window.alert("重试失败，请稍后再试。");
    } finally {
      // Always release the spinner — a "not_retriable" (or any non-error) response
      // must not leave the button stuck busy until a full page refresh.
      setBusy(false);
    }
  };

  if (busy) {
    return (
      <span className="act-cancel act-cancel-busy">
        <Loader2 size={14} className="act-spin" aria-hidden />
      </span>
    );
  }
  return (
    <button
      type="button"
      className="act-retry"
      aria-label={`重试获取 ${title}`}
      onClick={(event) => {
        // The row header toggles the step list — a click on 重试 must not also
        // expand/collapse the row.
        event.stopPropagation();
        void retry();
      }}
    >
      <RotateCcw size={13} aria-hidden /> 重试
    </button>
  );
}

function CancelButton({ runId, title }: { runId: string; title: string }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const cancel = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/activity/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId }),
      });
      const result = (await res.json()) as { status?: string };
      if (result.status !== "cancelled") {
        window.alert(`「${title}」已开始处理，无法取消。`);
      }
    } catch {
      window.alert("取消失败，请重试。");
    }
    // The next poll reconciles the list (removed if cancelled, or shown running).
  };

  if (busy) {
    return <span className="act-cancel act-cancel-busy"><Loader2 size={14} className="act-spin" aria-hidden /></span>;
  }
  if (confirming) {
    return (
      <span className="act-confirm">
        <button
          type="button"
          className="act-confirm-yes"
          onClick={(event) => {
            event.stopPropagation();
            void cancel();
          }}
        >
          取消并移出
        </button>
        <button
          type="button"
          className="act-confirm-no"
          onClick={(event) => {
            event.stopPropagation();
            setConfirming(false);
          }}
        >
          留着
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      className="act-cancel"
      aria-label={`取消获取 ${title}`}
      onClick={(event) => {
        // The row header toggles the step list — a click on 取消 must not also
        // expand/collapse the row.
        event.stopPropagation();
        setConfirming(true);
      }}
    >
      <X size={15} aria-hidden />
    </button>
  );
}

function CollapsibleSection({
  title,
  count,
  note,
  defaultOpen,
  children,
}: {
  title: string;
  count: number;
  note?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? true);
  return (
    <section className="act-section">
      <button type="button" className="act-section-head" onClick={() => setOpen((value) => !value)}>
        {open ? <ChevronDown size={15} aria-hidden /> : <ChevronRight size={15} aria-hidden />}
        {title} · {count}
        {note ? <span className="act-section-note">{note}</span> : null}
      </button>
      {open ? <div className="act-rows">{children}</div> : null}
    </section>
  );
}
