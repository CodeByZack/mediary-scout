import type { LanguageModel } from "ai";
import type { gradeCandidates } from "../../acquisition-v2/candidate-grader.js";
import type { AgentPhase, AgentToolEvent } from "../../acquisition-v2/activity.js";
import { getStorageBrand } from "../../storage-brands.js";
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

/** A/B/C/D 分布,兜底评分日志用(与主流程 stepLog 的「A x / B y / C z / D w」同款)。 */
export function gradeDistribution(grading: ReturnType<typeof gradeCandidates>): string {
  const counts = { A: 0, B: 0, C: 0, D: 0 };
  for (const g of grading.ranked) {
    counts[g.grade] += 1;
  }
  return `A ${counts.A} / B ${counts.B} / C ${counts.C} / D ${counts.D}`;
}
