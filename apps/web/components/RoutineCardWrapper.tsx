"use client";

import { useState } from "react";
import { CalendarClock, CheckCircle2 } from "lucide-react";
import type { NotificationEvent } from "@media-track/workflow";
import type { ActivityStepView } from "../lib/activity-view";
import { StepList, ExpandChevron } from "./activity-feed";

/** Client wrapper for the 例行巡检 card — owns per-item open state so each
 *  routine row can expand its run's step list independently. */
export function RoutineCardWrapper({
  items,
  time,
  itemsSteps,
}: {
  items: NotificationEvent[];
  time: string;
  itemsSteps: ActivityStepView[][];
}) {
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <RoutineCard
      items={items}
      time={time}
      itemsSteps={itemsSteps}
      openIds={openIds}
      onToggle={toggle}
    />
  );
}

/**
 * A scheduled sweep that found nothing to do for a set of shows collapses into a
 * single quiet "例行巡检" card that NAMES each show it checked (rather than a
 * "其余 N 部" count), with the current state of each.
 */
function RoutineCard({
  items,
  time,
  itemsSteps,
  openIds,
  onToggle,
}: {
  items: NotificationEvent[];
  time: string;
  itemsSteps: ActivityStepView[][];
  openIds: Set<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <article className="feed-card routine-card">
      <div className="feed-card-head">
        <span className="feed-icon tone-muted">
          <CalendarClock size={15} aria-hidden />
        </span>
        <strong className="feed-card-title">例行巡检</strong>
        <span className="feed-status-pill tone-muted">
          <CheckCircle2 size={11} aria-hidden />
          {items.length} 项已最新
        </span>
        <time className="feed-time" dateTime={time}>
          {timeLabel(time)}
        </time>
      </div>
      <ul className="routine-list">
        {items.map((item, index) => {
          const report = item.report;
          const heading = report
            ? report.seasonLabel
              ? `${report.titleName} ${report.seasonLabel}`
              : report.titleName
            : item.title;
          const line = report?.lines[0] ?? item.body;
          const isOpen = openIds.has(item.id);
          const steps = itemsSteps[index] ?? [];
          return (
            <li className="routine-item" key={item.id} onClick={() => onToggle(item.id)} style={{ cursor: "pointer" }}>
              <span className="routine-name">{heading}</span>
              {line ? <span className="routine-line">{line}</span> : null}
              <ExpandChevron open={isOpen} />
              {isOpen && steps.length > 0 && <div className="routine-step-list"><StepList steps={steps} /></div>}
              {isOpen && steps.length === 0 && <div className="routine-step-list"><p className="act-steps-empty">暂无步骤记录</p></div>}
            </li>
          );
        })}
      </ul>
    </article>
  );
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
  });
}
