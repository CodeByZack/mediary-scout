import type { LanguageModel } from "ai";
import type { gradeCandidates } from "../../acquisition-v2/candidate-grader.js";
import type { AgentPhase, AgentToolEvent } from "../../acquisition-v2/activity.js";
import { getStorageBrand } from "../../storage-brands.js";
import { episodeCodeFromFileName, episodeDateConflict } from "../../episode-code.js";
import type { TaskSandbox } from "../../acquisition-v2/sandbox.js";
import type { TvAnimeTarget } from "../../acquisition-v2/task-agents.js";

/**
 * fast path · 共享观测与循环原语（步骤⑤ 自 acquisition-v2/fast-path.ts 逐字搬迁）。
 * stepLog/emitStep 是日志与活动页文案的唯一出处 —— 字符串一字不改是重构红线。
 */

/** Stdout step log — the fnOS app log's per-run trace, so the user can follow
 *  which step a task reached and where it failed:
 *      [mediary-run][{runId}] {title} | {step}: {detail}
 *  Never prints credentials/links — only title / candidateId / counts /
 *  conclusion / reason. console.warn / console.error mark failing branches. */
export function stepLog(
  sandbox: TaskSandbox,
  title: string,
  step: string,
  detail: string,
  level: "log" | "warn" | "error" = "log",
): void {
  const line = `[mediary-run][${sandbox.logRunId}] ${title} | ${step}: ${detail}`;
  if (level === "warn") console.warn(line);
  else if (level === "error") console.error(line);
  else console.log(line);
}

/** First line of every fast-path run: which 网盘 this task writes to. Unknown /
 *  absent provider falls back to the raw string so tests and bare sandboxes
 *  still print something useful. */
export function logStorageProvider(sandbox: TaskSandbox, title: string, storageProvider?: string): void {
  const provider = storageProvider ?? "unknown";
  let label = provider;
  try {
    label = getStorageBrand(provider).label;
  } catch {
    // unknown brand string — keep the raw provider id.
  }
  stepLog(sandbox, title, "网盘", `${label} (${provider})`);
}

/** Fire-and-forget step trace: EVERY fast-path step also emits an AgentToolEvent
 *  through onProgress — the runner wires that to the SAME progress + agent-trace
 *  sinks the agent path uses, so the activity page shows fast-path steps (and a
 *  live progress bar) instead of a blank row. toolName mirrors the semantic
 *  agent tool where one exists; phase follows the requirement mapping
 *  (落点检查→search、预搜/评分→search、选片→pick、转存→transfer、digest→verify、
 *  归位→organize、markObtained→mark、结论→finalize). A missing/throwing sink must
 *  NEVER fail the run — observability only. */
export function emitStep(
  onProgress: ((event: AgentToolEvent) => void) | undefined,
  toolName: string,
  phase: AgentPhase,
  activity: string,
  args: Record<string, unknown> = {},
): void {
  if (!onProgress) return;
  try {
    onProgress({ toolName, args, activity, phase });
  } catch {
    // observability never fails the fast path
  }
}

export interface FastPathOptions {
  sandbox: TaskSandbox;
  model: LanguageModel;
  target: TvAnimeTarget;
  /** CN-origin works are natively Chinese-spoken → no 中字 gate in grading. */
  isChineseNative: boolean;
  /** The run's drive brand ("pan115" | "quark" | …) — printed at the top of the
   *  run so the log shows which 网盘 this task is writing to. */
  storageProvider?: string;
  /** Live step trace for the activity page (Task D): the runner wires its
   *  progress + agent-trace sinks here; the fast path emits one AgentToolEvent
   *  per step, fire-and-forget. Undefined (tests / bare sandbox) = no trace. */
  onProgress?: (event: AgentToolEvent) => void;
}

export interface FastPathResult {
  /** Human-readable outcome (feeds the persisted decision reason). */
  text: string;
  /** Transfer attempts made (stands in for the agent's tool-loop step count). */
  steps: number;
  coverage: { coverageMet: boolean; obtained: string[]; missing: string[]; subtitleFallback: boolean };
  /** Whether the run escalated to the arbitrator (token-optimization signal). */
  escalated: boolean;
}

export function nextCandidate(
  grading: ReturnType<typeof gradeCandidates>,
  attempted: Set<string>,
): string | null {
  const next = grading.ranked.find((c) => c.grade !== "D" && !attempted.has(c.id));
  return next?.id ?? null;
}

/** Conclude an uncovered run: record the no-coverage audit (same as the agent's
 *  reportNoCoverage), then finish. A fully-unhealthy evidence base throws
 *  SANDBOX_SOURCE_UNHEALTHY upward — the caller must surface the source fault,
 *  not record "no resource". */
export async function concludeUncovered(
  sandbox: TaskSandbox,
  opts: { text: string; steps: number; escalated: boolean; reason: string },
): Promise<FastPathResult> {
  await sandbox.reportNoCoverage(opts.reason);
  return {
    text: opts.text,
    steps: opts.steps,
    coverage: await sandbox.finish(),
    escalated: opts.escalated,
  };
}

export function fileBaseName(path: string): string {
  return path.split("/").pop() ?? path;
}

/** agent-trace-sink 对 args JSON >2000 字符整体硬截(_truncated)——证据列表必须自带预算,否则 UI 只会看到「参数过长已省略」。 */
const EVIDENCE_BUDGET = 1800;

function pushWithinBudget<T>(out: T[], rows: T[], budget = EVIDENCE_BUDGET): T[] {
  let size = 2;
  for (const row of rows) {
    const cost = JSON.stringify(row).length + 1;
    if (size + cost > budget) break;
    out.push(row);
    size += cost;
  }
  return out;
}

function shortCandidateId(id: string): string {
  return id.length > 28 ? "…" + id.slice(-24) : id;
}

interface EvidenceCandidate {
  id: string;
  title: string;
  grade: string;
  reasons: string[];
  seasons?: number[];
  quality?: string;
}

/** L2 证据 payload(预算化):紧凑评级列表,供活动页展开。 */
export function gradedCandidateEvidence(
  grading: ReturnType<typeof gradeCandidates>,
): EvidenceCandidate[] {
  const rows = grading.ranked.map((candidate) => ({
    id: shortCandidateId(candidate.id),
    title: candidate.title.slice(0, 100),
    grade: candidate.grade,
    reasons: candidate.reasons.slice(0, 2).map((reason) => reason.slice(0, 70)),
    ...(candidate.seasonNumbers.length > 0 ? { seasons: candidate.seasonNumbers } : {}),
    ...(candidate.quality !== null ? { quality: candidate.quality } : {}),
  }));
  return pushWithinBudget([], rows);
}

/** 预搜快照版:只有标题的证据(同样预算化)。 */
export function candidateTitleEvidence(
  candidates: Array<{ id: string; title: string }>,
): Array<{ id: string; title: string }> {
  const rows = candidates.map((candidate) => ({
    id: shortCandidateId(candidate.id),
    title: candidate.title.slice(0, 100),
  }));
  return pushWithinBudget([], rows);
}

const VIDEO_EXT = /\.(mkv|mp4|avi|ts|webm|mov|m4v|wmv|flv|iso)$/i;

/** L4 证据 payload:落盘视频逐文件集数解析行;⚠ = 裸数字按目标季解释(issue #21 可见层)。 */
export function landingParseRows(
  files: Array<{ path: string }>,
  seasons: number[],
  episodeAirDates?: Record<string, string>,
): string[] {
  const rows = files
    .filter((file) => VIDEO_EXT.test(file.path))
    .map((file) => {
      const base = fileBaseName(file.path);
      const code = episodeCodeFromFileName(base, seasons);
      const bare = /^\d{1,3}$/.test(base.replace(/\.[^.]+$/i, ""));
      const shown = base.length > 48 ? base.slice(0, 45) + "…" : base;
      if (!code) return shown + " → 解析失败";
      if (episodeDateConflict(code, base, episodeAirDates)) {
        return shown + ` → ${code} ⚠(文件日期与该集播出日不符,不采信)`;
      }
      return shown + " → " + code + (bare ? " ⚠(裸数字,按目标季解释)" : "");
    });
  const kept = pushWithinBudget<string>([], rows, 1850);
  if (kept.length < rows.length) {
    kept.push(`…另有 ${rows.length - kept.length} 条未列`);
  }
  return kept;
}

/** A/B/C/D 分布,兜底评分日志用(与主流程 stepLog 的「A x / B y / C z / D w」同款)。 */
export function gradeDistribution(grading: ReturnType<typeof gradeCandidates>): string {
  const counts = { A: 0, B: 0, C: 0, D: 0 };
  for (const g of grading.ranked) {
    counts[g.grade] += 1;
  }
  return `A ${counts.A} / B ${counts.B} / C ${counts.C} / D ${counts.D}`;
}

/** stdout 命中摘要(fnOS 日志可见层):前几条候选「标题[评级]」,标题截 24 字,
 *  溢出以「＋N」收尾。与分布行互补——分布行只报数,这行报「池子里到底是什么」。
 *  只含标题与评级,无任何链接,stdout 红线安全。 */
export function evidenceDigestLine(
  grading: ReturnType<typeof gradeCandidates>,
  maxItems = 3,
): string {
  const items = grading.ranked.slice(0, maxItems).map((candidate) => {
    const shown =
      candidate.title.length > 24 ? candidate.title.slice(0, 23) + "…" : candidate.title;
    return `「${shown}」[${candidate.grade}]`;
  });
  const rest = grading.ranked.length - items.length;
  return items.join(" ") + (rest > 0 ? ` ＋${rest}` : "");
}
