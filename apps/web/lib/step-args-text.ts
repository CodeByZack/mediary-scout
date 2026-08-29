import type { ActivityStepView } from "./activity-view";

/** Extract a short display line from a step's raw tool args. Returns null when
 *  nothing user-meaningful exists (ids/paths only) — the UI then omits the args
 *  row instead of dumping the whole JSON. Rename steps are prioritized: the raw
 *  args carry `renames:[{fileId,newName}]` where fileId is an internal id, so we
 *  surface the canonical target names ("改名 …").
 *  纯函数(自 components/activity-feed.tsx 抽出,可单测):渲染 agent_steps args 的一行摘要。
 *  可观测性增强(§21 L2/L3/L4)在此消费 candidates/pool/files 证据 payload。 */
export function stepArgsText(step: ActivityStepView): string | null {
  const args = step.args;
  if (!args || typeof args !== "object") {
    return null;
  }
  if (args._truncated === true) {
    return "参数过长已省略";
  }
  const renames = args.renames;
  if (Array.isArray(renames) && renames.length > 0) {
    const names = renames
      .map((rename) => {
        const newName = (rename as { newName?: unknown } | null)?.newName;
        return typeof newName === "string" && newName.trim() ? newName.trim() : null;
      })
      .filter((name): name is string => name !== null);
    if (names.length > 0) {
      const shown = names.slice(0, 3).join("、");
      return names.length > 3 ? `改名 ${shown} 等 ${names.length} 个` : `改名 ${shown}`;
    }
  }
  const moves = args.moves;
  if (Array.isArray(moves) && moves.length > 0) {
    const parts = moves.map((move) => {
      const season = (move as { season?: unknown } | null)?.season;
      return typeof season === "number" ? `第 ${season} 季` : "影片目录";
    });
    return `分发到 ${parts.join("、")}`;
  }
  const codes = args.codes;
  if (Array.isArray(codes) && codes.length > 0) {
    return `已标记 ${codes.length} 集`;
  }
  const keyword =
    typeof args.keyword === "string" && args.keyword.trim() ? args.keyword.trim() : null;
  // L2/L3 候选证据(gradingDecision / viewResourceSnapshot / gradeCandidates /
  // arbitrateSelection):评级池前 3 条「标题[评级]」,兜底评分事件带搜索词前缀。
  const evidence = Array.isArray(args.candidates)
    ? args.candidates
    : Array.isArray(args.pool)
      ? args.pool
      : null;
  if (evidence && evidence.length > 0) {
    const parts = evidence.slice(0, 3).map((item) => {
      const record = (item ?? {}) as Record<string, unknown>;
      const title = typeof record.title === "string" ? record.title.slice(0, 24) : "?";
      const grade = typeof record.grade === "string" ? `[${record.grade}]` : "";
      return `「${title}」${grade}`;
    });
    const tail = evidence.length > 3 ? ` 等 ${evidence.length} 条` : "";
    const prefix = keyword ? `词「${keyword}」· ` : "";
    return `${prefix}证据: ${parts.join("、")}${tail}`;
  }
  // L4 逐文件解析(digestFiles):前 2 行原文 + 计数在 activity 文案里。
  const files = args.files;
  if (Array.isArray(files) && files.length > 0) {
    const rows = files.filter((row): row is string => typeof row === "string");
    if (rows.length > 0) {
      return `解析: ${rows.slice(0, 2).join(" ｜ ")}`;
    }
  }
  if (keyword) {
    return `关键词: ${keyword}`;
  }
  const fileIds = args.fileIds;
  if (Array.isArray(fileIds) && fileIds.length > 0) {
    return `${fileIds.length} 个文件`;
  }
  return null;
}

/** 结构化明细(§23 UI 证据流):候选评级池的「全量行」与 digestFiles 的逐文件行。
 *  stepArgsText 是一行摘要(列表模式),本函数供组件渲染展开态——两者同源,
 *  组件在有结构化行时跳过一行摘要,不重复展示。数据在写入侧已预算化
 *  (§21 L2:标题≤100、判因≤2×70),渲染侧不再截断计数。 */
export interface StepEvidenceRow {
  title: string;
  grade: string | null;
  reasons: string[];
}

export type StepDetailView =
  | { kind: "candidates"; keyword: string | null; rows: StepEvidenceRow[] }
  | { kind: "files"; rows: string[] }
  | null;

export function stepDetailView(step: ActivityStepView): StepDetailView {
  const args = step.args;
  if (!args || typeof args !== "object" || args._truncated === true) {
    return null;
  }
  const evidence = Array.isArray(args.candidates)
    ? args.candidates
    : Array.isArray(args.pool)
      ? args.pool
      : null;
  if (evidence && evidence.length > 0) {
    const keyword =
      typeof args.keyword === "string" && args.keyword.trim() ? args.keyword.trim() : null;
    const rows = evidence.map((item) => {
      const record = (item ?? {}) as Record<string, unknown>;
      const rawReasons: unknown[] = Array.isArray(record.reasons) ? record.reasons : [];
      const reasons = rawReasons.filter(
        (reason): reason is string => typeof reason === "string" && reason.length > 0,
      );
      return {
        title: typeof record.title === "string" ? record.title : "?",
        grade: typeof record.grade === "string" ? record.grade : null,
        reasons,
      };
    });
    return { kind: "candidates", keyword, rows };
  }
  const files = args.files;
  if (Array.isArray(files) && files.length > 0) {
    const rows = files.filter((row): row is string => typeof row === "string");
    if (rows.length > 0) {
      return { kind: "files", rows };
    }
  }
  return null;
}
