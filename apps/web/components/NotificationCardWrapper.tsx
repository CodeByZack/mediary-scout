"use client";

import Link from "next/link";
import { useState } from "react";
import {
  Bell,
  CheckCircle2,
  CircleSlash,
  Clock3,
  DownloadCloud,
  Film,
  Layers,
  PartyPopper,
  RotateCcw,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import type { NotificationEvent, NotificationReportStatus } from "@media-track/workflow";
import { collapseToRanges } from "../lib/episode-ranges";
import type { ActivityStepView } from "../lib/activity-view";
import { StepList, ExpandChevron } from "./activity-feed";

// The kind only drives the leading ICON now — its textual label used to render
// as a second badge next to the status pill ("开始追踪" beside "已完结"), which
// was redundant. The status pill is the single source of truth for state.
// TMDB's own CDN — same source the push notification uses; w154 is a crisp
// thumbnail for the feed card without shipping a self-hosted image.
const TMDB_FEED_POSTER = "https://image.tmdb.org/t/p/w154";

const kindIcon: Record<string, { tone: string; icon: typeof Bell }> = {
  series_initialized: { tone: "green", icon: Layers },
  package_initialized: { tone: "green", icon: Film },
  tracking_initialized: { tone: "indigo", icon: DownloadCloud },
  episodes_restored: { tone: "indigo", icon: DownloadCloud },
  tracking_completed: { tone: "green", icon: PartyPopper },
  already_current: { tone: "muted", icon: CheckCircle2 },
  no_coverage: { tone: "amber", icon: CircleSlash },
  transfer_failed: { tone: "amber", icon: XCircle },
  foreign_work_detected: { tone: "amber", icon: Film },
};

const statusMeta: Record<NotificationReportStatus, { label: string; tone: string; icon: typeof Bell }> = {
  complete: { label: "已完结", tone: "green", icon: CheckCircle2 },
  acquired: { label: "已入库", tone: "green", icon: CheckCircle2 },
  airing: { label: "追更中", tone: "indigo", icon: Clock3 },
  partial: { label: "有缺集", tone: "amber", icon: TriangleAlert },
  no_coverage: { label: "暂无资源", tone: "amber", icon: CircleSlash },
  failed: { label: "获取失败", tone: "amber", icon: XCircle },
  retrying: { label: "重试中", tone: "indigo", icon: RotateCcw },
};

/** Client wrapper for an expandable notification card — owns the open state and
 *  renders the card body plus the collapsible step list. `size` is computed by
 *  the server (`landedSize`) and passed down as plain serializable data so this
 *  client module never imports the server-only workflow runtime. */
export function NotificationCardWrapper({
  notification,
  steps,
  size,
  fallbackPoster = null,
}: {
  notification: NotificationEvent;
  steps: ActivityStepView[];
  size: { label: string; value: string } | null;
  fallbackPoster?: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <NotificationCard
      notification={notification}
      steps={steps}
      size={size}
      open={open}
      onToggle={() => setOpen((value) => !value)}
      fallbackPoster={fallbackPoster}
    />
  );
}

/** One acquisition/tracking event — its own separated card. */
function NotificationCard({
  notification,
  steps,
  size,
  open,
  onToggle,
  fallbackPoster = null,
}: {
  notification: NotificationEvent;
  steps: ActivityStepView[];
  size: { label: string; value: string } | null;
  open: boolean;
  onToggle: () => void;
  fallbackPoster?: string | null;
}) {
  const icon = kindIcon[notification.kind] ?? { tone: "muted", icon: Bell };
  const KindIcon = icon.icon;
  const report = notification.report;

  // Legacy / report-less events (foreign work, old plain records).
  if (!report) {
    return (
      <article className="feed-card" data-created-at={notification.createdAt}>
        <div className="feed-card-head">
          <span className={`feed-icon tone-${icon.tone}`}>
            <KindIcon size={15} aria-hidden />
          </span>
          <strong className="feed-card-title">{notification.title}</strong>
          <time className="feed-time" dateTime={notification.createdAt}>
            {timeLabel(notification.createdAt)}
          </time>
        </div>
        <p className="feed-card-line">{notification.body}</p>
        {notification.kind === "foreign_work_detected" ? (
          <Link
            className="feed-action"
            href={`/foreign-work/${encodeURIComponent(notification.workflowRunId)}`}
          >
            去处理 →
          </Link>
        ) : null}
      </article>
    );
  }

  const status = statusMeta[report.status];
  const StatusIcon = status.icon;
  const heading = report.seasonLabel
    ? `${report.titleName} ${report.seasonLabel}`
    : report.year
      ? `${report.titleName} (${report.year})`
      : report.titleName;
  // A movie's only line is "已获取入库", which the "已入库" pill already conveys —
  // drop it so the card carries no duplicated sentence. Seasons keep their
  // informative progress line(s).
  const lines = report.status === "acquired" ? [] : report.lines;
  const hasChips = report.newlyObtained.length > 0 || report.realMissing.length > 0 || Boolean(size);
  const posterPath = report.posterPath ?? fallbackPoster;
  const posterUrl = posterPath ? `${TMDB_FEED_POSTER}${posterPath}` : null;

  return (
    <article className={`feed-card${posterUrl ? " has-poster" : ""}`} data-created-at={notification.createdAt}>
      {posterUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="feed-poster" src={posterUrl} alt="" loading="lazy" />
      ) : null}
      <div className="feed-card-body">
        <div className="feed-card-head" onClick={onToggle} style={{ cursor: "pointer" }}>
          <span className={`feed-icon tone-${icon.tone}`}>
            <KindIcon size={15} aria-hidden />
          </span>
          <strong className="feed-card-title">{heading}</strong>
          <span className={`feed-status-pill tone-${status.tone}`}>
            <StatusIcon size={11} aria-hidden />
            {status.label}
          </span>
          <time className="feed-time" dateTime={notification.createdAt}>
            {timeLabel(notification.createdAt)}
          </time>
          <ExpandChevron open={open} />
        </div>

        {lines.length > 0 ? (
          <div className="feed-card-lines">
            {lines.map((line) => (
              <p className="feed-card-line" key={line}>
                {line}
              </p>
            ))}
          </div>
        ) : null}

        {hasChips ? (
          <div className="feed-card-chips">
            <ChipGroup label="本次新增" codes={report.newlyObtained} variant="is-new" />
            <ChipGroup label="缺集" codes={report.realMissing} variant="is-missing" />
            {size ? (
              <span className="feed-chip-group">
                <span className="feed-chip-label">{size.label}</span>
                <span className="feed-chips">
                  <span className="feed-chip">{size.value}</span>
                </span>
              </span>
            ) : null}
          </div>
        ) : null}

        {open && steps.length > 0 && <StepList steps={steps} />}
        {open && steps.length === 0 && <div className="act-step-list"><p className="act-steps-empty">暂无步骤记录</p></div>}
      </div>
    </article>
  );
}

function ChipGroup({ label, codes, variant }: { label: string; codes: string[]; variant: string }) {
  if (codes.length === 0) {
    return null;
  }
  // Collapse contiguous episodes into ranges so a 164-episode acquisition is a few
  // tokens (E01–E164 · E170 · E175–E178), not 164 chips that stretch the card.
  const ranges = collapseToRanges(codes);
  return (
    <span className="feed-chip-group">
      <span className="feed-chip-label">
        {label} {codes.length}
      </span>
      <span className="feed-chips">
        {ranges.map((range) => (
          <span className={`feed-chip ${variant}`} key={range}>
            {range}
          </span>
        ))}
      </span>
    </span>
  );
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
  });
}
