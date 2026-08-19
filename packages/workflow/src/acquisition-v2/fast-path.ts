import type { LanguageModel } from "ai";
import { episodeCodeFromFileName } from "../episode-code.js";
import { normalizeSearchKeyword } from "../planning-search-gate.js";
import {
  arbitrateDiagnosis,
  arbitrateMovieDiagnosis,
  arbitrateMovieSelection,
  arbitrateSelection,
} from "./arbitrator.js";
import { gradeCandidates, summarizeGrading } from "./candidate-grader.js";
import { finalizeLanding, finalizeMovieLanding } from "./finalize-landing.js";
import { TaskSandbox } from "./sandbox.js";
import { digestMovieStaging, digestStaging } from "./staging-digest.js";
import type { MovieTarget, TvAnimeTarget } from "./task-agents.js";
import type { AgentPhase, AgentToolEvent } from "./activity.js";

/**
 * The fast path (§6.5): the acquisition happy path runs entirely in CODE, with
 * the LLM demoted from "full-driver 60-step tool loop" to two pure single-call
 * judgments (the arbitrator). Flow:
 *
 *   inspect landing point (§6b#8) → candidate grading (code) →
 *     unique A-grade ? transfer : arbitrateSelection →
 *     transfer (code) → staging digest (code) → passes ? finalize : arbitrateDiagnosis
 *
 * A clean run (unique A-grade that lands and digests cleanly) makes ZERO LLM
 * calls. Only genuine ambiguity — no unique A-grade, or a dirty/off-target
 * landing — escalates, and each escalation is one judgment call, not a loop.
 */

/** Hard ceiling on transfer attempts per fast-path run. */
const MAX_TRANSFER_ATTEMPTS = 3;

/** Dead-link retries must NOT consume the transfer-attempt budget: a dead share
 *  fails loud (分享已过期/已取消/不存在) at the share-check step WITHOUT any real
 *  transfer action (no 秒传/复制), so it is a cheap probe. Cap the dead-link
 *  scan separately so a candidate pool full of dead shares still gets scanned
 *  for a live one (狂飙 45 候选只试 3 个死链就放弃的教训). */
const MAX_DEAD_LINK_RETRIES = 10;

/** Hard ceiling on ALIASES 兜底重搜 rounds per fast-path run. The primary search
 *  already ran; each fallback round is one more PanSou hit, so cap it hard (≤3)
 *  to keep a title that fails to recall from hammering the shared quota. */
const MAX_FALLBACK_SEARCHES = 3;

/** Stdout step log — the fnOS app log's per-run trace, so the user can follow
 *  which step a task reached and where it failed:
 *      [mediary-run][{runId}] {title} | {step}: {detail}
 *  Never prints credentials/links — only title / candidateId / counts /
 *  conclusion / reason. console.warn / console.error mark failing branches. */
function stepLog(
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

/** Fire-and-forget step trace: EVERY fast-path step also emits an AgentToolEvent
 *  through onProgress — the runner wires that to the SAME progress + agent-trace
 *  sinks the agent path uses, so the activity page shows fast-path steps (and a
 *  live progress bar) instead of a blank row. toolName mirrors the semantic
 *  agent tool where one exists; phase follows the requirement mapping
 *  (落点检查→search、预搜/评分→search、选片→pick、转存→transfer、digest→verify、
 *  归位→organize、markObtained→mark、结论→finalize). A missing/throwing sink must
 *  NEVER fail the run — observability only. */
function emitStep(
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

function nextCandidate(
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
async function concludeUncovered(
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

function fileBaseName(path: string): string {
  return path.split("/").pop() ?? path;
}

/** A/B/C/D 分布,兜底评分日志用(与主流程 stepLog 的「A x / B y / C z / D w」同款)。 */
function gradeDistribution(grading: ReturnType<typeof gradeCandidates>): string {
  const counts = { A: 0, B: 0, C: 0, D: 0 };
  for (const g of grading.ranked) {
    counts[g.grade] += 1;
  }
  return `A ${counts.A} / B ${counts.B} / C ${counts.C} / D ${counts.D}`;
}

/**
 * Aliases 兜底重搜 (§C). The fast path's primary search recalls by the bare
 * title ONLY — when it comes back empty, or grades without a unique A-grade
 * (the 泰德·拉索 case: the title search drowns in unrelated hits while the
 * aliases' 足球教练 never gets searched), each alias gets ONE more
 * primeRawSnapshot round, in the order the target carries them — English
 * original first, then the other 译名 (zh-TW/zh-HK) — until a unique A-grade
 * appears or the budget (≤ MAX_FALLBACK_SEARCHES rounds) runs out.
 *
 * primeRawSnapshot OVERWRITES the prior raw snapshot, so a successful fallback's
 * returned view/grading are the LAST searched evidence — the caller's
 * arbitration / transfer must read them, never the pre-fallback snapshot.
 *
 * §E restore: when the fallback exhausts its budget WITHOUT finding a unique
 * A-grade AND the primary snapshot had candidates, the primary evidence is
 * restored (returned as-is) so the caller continues the ORIGINAL arbitration /
 * give-up logic on the primary candidates — never "暂无资源" just because the
 * LAST fallback snapshot came back empty (the 狂飙 case: primary 45 候选被丢).
 * The restore is in-memory (the primary snapshot id is already in
 * observedSnapshots, so transferCandidate works), NOT a re-prime — zero extra
 * PanSou hits, the budget semantics stay untouched.
 *
 * Budget: ≤ MAX_FALLBACK_SEARCHES additional PanSou hits, keywords deduped
 * (the title counts as already used). A provider failure on one round keeps the
 * previous snapshot and moves to the next alias — bounded, so a dead source
 * costs at most the budget, never the run. aliases 为空时调用方根本不会进来,
 * 行为与「一次搜索直接走原逻辑」完全一致。
 */
async function aliasesFallbackReSearch(input: {
  sandbox: TaskSandbox;
  title: string;
  aliases: string[];
  view: NonNullable<ReturnType<TaskSandbox["rawSnapshotView"]>>;
  grading: ReturnType<typeof gradeCandidates>;
  grade: (candidates: Array<{ id: string; title: string }>) => ReturnType<typeof gradeCandidates>;
  onProgress?: (event: AgentToolEvent) => void;
}): Promise<{
  view: NonNullable<ReturnType<TaskSandbox["rawSnapshotView"]>>;
  grading: ReturnType<typeof gradeCandidates>;
}> {
  const { sandbox, title, aliases, view, grading, grade, onProgress } = input;
  const searched = new Set<string>([normalizeSearchKeyword(title)]);
  let currentView = view;
  let currentGrading = grading;
  let rounds = 0;
  let foundUniqueA = false;
  for (const alias of aliases) {
    if (rounds >= MAX_FALLBACK_SEARCHES) break;
    const keyword = normalizeSearchKeyword(alias);
    if (keyword === "" || searched.has(keyword)) continue; // 用过的词去重
    searched.add(keyword);
    rounds += 1;
    const roundDetail = `keyword=「${alias}」(第 ${rounds}/${MAX_FALLBACK_SEARCHES} 轮)`;
    stepLog(sandbox, title, "兜底重搜", roundDetail);
    emitStep(onProgress, "searchResources", "search", roundDetail, { keyword: alias });
    try {
      await sandbox.primeRawSnapshot(alias);
    } catch (error) {
      // Provider down on a fallback round — keep the current snapshot and try the
      // next alias (bounded by the budget; a dead source never kills the run).
      const failDetail = `keyword=「${alias}」搜索失败:${error instanceof Error ? error.message : String(error)}`;
      stepLog(sandbox, title, "兜底重搜", failDetail, "warn");
      emitStep(onProgress, "searchResources", "search", failDetail, { keyword: alias });
      continue;
    }
    const nextView = sandbox.rawSnapshotView();
    if (!nextView) continue; // defensive: prime succeeded, so a view must exist
    currentView = nextView;
    currentGrading = grade(nextView.candidates);
    const gradeDetail = `keyword=「${alias}」命中=${nextView.candidates.length} ${
      currentGrading.uniqueTopGrade
        ? `唯一A级 top=${currentGrading.top?.id}(${currentGrading.top?.title})`
        : gradeDistribution(currentGrading)
    }`;
    stepLog(sandbox, title, "兜底评分", gradeDetail);
    emitStep(onProgress, "gradeCandidates", "search", gradeDetail);
    if (nextView.candidates.length > 0 && currentGrading.uniqueTopGrade) {
      foundUniqueA = true;
      break; // 唯一 A → 直接转存
    }
  }
  // §E: 兜底全失败(没有唯一 A)且 primary 快照有候选 → 恢复 primary 证据继续原
  // 仲裁/放弃逻辑。旧行为让「最后一个兜底快照为空」覆盖 primary 的候选,于是
  // 狂飙 primary 45 条候选被丢、误报「暂无资源(快照为空)」。恢复用内存里的
  // primary view(其 snapshotId 早已在 observedSnapshots,transferCandidate 可直接
  // 用),不重新 primeRawSnapshot —— 零额外 PanSou 请求,预算语义原样保持。
  if (!foundUniqueA && view.candidates.length > 0) {
    const restoreDetail = `全部兜底无唯一 A,恢复 primary 快照(${view.candidates.length} 条候选)继续仲裁`;
    stepLog(sandbox, title, "兜底重搜", restoreDetail);
    emitStep(onProgress, "gradeCandidates", "search", restoreDetail);
    return { view, grading };
  }
  return { view: currentView, grading: currentGrading };
}

export async function runFastPathAcquisition(options: FastPathOptions): Promise<FastPathResult> {
  const { sandbox, model, target, isChineseNative, onProgress } = options;
  const seasons = target.seasons;

  // 0. Inspect the landing point FIRST (§6b#8): the DB can lag the disk (a prior
  //    run placed files, or a crash left them mid-flight), so episodes already
  //    sitting in their season dirs are marked obtained and dropped from the need
  //    — never re-searched or re-transferred.
  let needCodes = [...target.missingEpisodes];
  const alreadyPresent = new Set<string>();
  const onDisk = await sandbox.inspectTargetDir();
  for (const file of onDisk) {
    const code = episodeCodeFromFileName(fileBaseName(file.path));
    if (code && needCodes.includes(code)) {
      alreadyPresent.add(code);
    }
  }
  if (alreadyPresent.size > 0) {
    needCodes = needCodes.filter((code) => !alreadyPresent.has(code));
  }
  const landingDetail =
    alreadyPresent.size > 0
      ? `已在库 ${alreadyPresent.size} 集(${[...alreadyPresent].join(",")}),仍需 ${needCodes.length} 集`
      : `目标目录无已落盘集,仍需 ${needCodes.length} 集`;
  emitStep(onProgress, "inspectTargetDir", "search", landingDetail);
  if (alreadyPresent.size > 0) {
    await sandbox.markObtained({ codes: [...alreadyPresent] });
    emitStep(
      onProgress,
      "markObtained",
      "mark",
      `已确认 ${alreadyPresent.size} 集入库(${[...alreadyPresent].join(",")})`,
      { codes: [...alreadyPresent] },
    );
  }
  stepLog(sandbox, target.title, "落点检查", landingDetail);
  if (needCodes.length === 0) {
    // The library already holds the whole need — no search, no transfer, no LLM.
    const doneDetail = `入库:已在库(${[...alreadyPresent].join(",") || "-"})`;
    stepLog(sandbox, target.title, "结论", doneDetail);
    emitStep(onProgress, "finish", "finalize", doneDetail);
    return {
      text: `fast path 已在库:${[...alreadyPresent].join(",")}`,
      steps: 0,
      coverage: await sandbox.finish(),
      escalated: false,
    };
  }

  // 1. Grade the primed raw-snapshot candidates (code, zero LLM).
  let raw = sandbox.rawSnapshotView();
  if (!raw) {
    // The raw pre-warm never landed (search source down) — there is NO evidence
    // base, so reportNoCoverage would throw SANDBOX_NO_PROVIDER_EVIDENCE (its
    // §9 guard: no search ran). Surface the source fault as uncovered, not as
    // "no resource".
    const snapshotDetail = "无(搜索源未响应)";
    stepLog(sandbox, target.title, "预搜快照", snapshotDetail, "warn");
    emitStep(onProgress, "viewResourceSnapshot", "search", snapshotDetail);
    const doneDetail = "暂无资源(搜索源未响应)";
    stepLog(sandbox, target.title, "结论", doneDetail);
    emitStep(onProgress, "reportNoCoverage", "finalize", doneDetail);
    return {
      text: "无预搜快照(搜索源未响应)",
      steps: 0,
      coverage: await sandbox.finish(),
      escalated: false,
    };
  }
  const snapshotDetail =
    raw.candidates.length === 0 ? "候选 0 条(快照为空)" : `候选 ${raw.candidates.length} 条`;
  stepLog(sandbox, target.title, "预搜快照", snapshotDetail, raw.candidates.length === 0 ? "warn" : "log");
  emitStep(onProgress, "viewResourceSnapshot", "search", snapshotDetail);

  let grading = gradeCandidates(raw.candidates, {
    title: target.title,
    aliases: target.aliases,
    seasons,
    isChineseNative,
  });

  // 1b. Aliases 兜底重搜: the primary search recalled by target.title ONLY — when
  //     it comes back empty, or grades without a unique A (the 泰德·拉索 case: the
  //     title search drowns in unrelated hits while the aliases' 足球教练 never
  //     gets searched), re-search with each alias until a unique A-grade appears
  //     or the budget (≤3 rounds) runs out. primeRawSnapshot OVERWRITES the
  //     snapshot, so grading/arbitration/transfer after a fallback read the NEW
  //     evidence — unless the whole fallback fails AND primary had candidates
  //     (§E: restore the primary evidence instead of discarding it).
  if ((raw.candidates.length === 0 || !grading.uniqueTopGrade) && target.aliases.length > 0) {
    const fallback = await aliasesFallbackReSearch({
      sandbox,
      title: target.title,
      aliases: target.aliases,
      view: raw,
      grading,
      ...(onProgress ? { onProgress } : {}),
      grade: (candidates) =>
        gradeCandidates(candidates, {
          title: target.title,
          aliases: target.aliases,
          seasons,
          isChineseNative,
        }),
    });
    raw = fallback.view;
    grading = fallback.grading;
  }

  if (raw.candidates.length === 0) {
    const doneDetail = "暂无资源(快照为空)";
    stepLog(sandbox, target.title, "结论", doneDetail);
    emitStep(onProgress, "reportNoCoverage", "finalize", doneDetail);
    return concludeUncovered(sandbox, {
      text: "无候选(raw snapshot 为空)",
      steps: 0,
      escalated: false,
      reason: "raw snapshot 为空",
    });
  }

  const gradeCounts = { A: 0, B: 0, C: 0, D: 0 };
  for (const candidate of grading.ranked) gradeCounts[candidate.grade] += 1;
  const gradingDetail = `A ${gradeCounts.A} / B ${gradeCounts.B} / C ${gradeCounts.C} / D ${gradeCounts.D}`;
  stepLog(sandbox, target.title, "评分", gradingDetail);
  emitStep(onProgress, "gradeCandidates", "search", gradingDetail);

  // 2. Pick the first candidate: a unique A-grade transfers blind; otherwise the
  //    selection arbitrator picks one (escalation #1).
  let escalated = false;
  let current: string | null;
  if (grading.uniqueTopGrade && grading.top) {
    current = grading.top.id;
    const pickDetail = `唯一 A 盲转:候选 ${current}(${grading.top.title})`;
    stepLog(sandbox, target.title, "选片", pickDetail);
    emitStep(onProgress, "pickCandidate", "pick", pickDetail);
  } else {
    escalated = true;
    const arbitration = await arbitrateSelection({
      model,
      summary: summarizeGrading(grading),
      title: target.title,
      seasons,
    });
    current = arbitration.candidateId;
    if (current === null) {
      const declineDetail = `放弃:${arbitration.reasoning || "无可用候选"}`;
      stepLog(sandbox, target.title, "仲裁", declineDetail, "warn");
      const doneDetail = `暂无资源(仲裁放弃:${arbitration.reasoning || "无可用候选"})`;
      stepLog(sandbox, target.title, "结论", doneDetail);
      emitStep(onProgress, "arbitrateSelection", "pick", declineDetail);
      emitStep(onProgress, "reportNoCoverage", "finalize", doneDetail);
      return concludeUncovered(sandbox, {
        text: `仲裁放弃:${arbitration.reasoning || "无可用候选"}`,
        steps: 0,
        escalated,
        reason: arbitration.reasoning || "无可用候选",
      });
    }
    // Defense-in-depth: the model only sees the graded summary and may return a
    // TITLE or a made-up id instead of a real candidate id. A bogus id must never
    // reach transferCandidate's SANDBOX_CANDIDATE_NOT_IN_SNAPSHOT throw and blow
    // up the whole run — treat it like a declined arbitration (safe uncover).
    if (!raw.candidates.some((candidate) => candidate.id === current)) {
      const badIdDetail = `返回非法候选 id:${current}`;
      stepLog(sandbox, target.title, "仲裁", badIdDetail, "error");
      const doneDetail = `暂无资源(仲裁返回非法候选:${current})`;
      stepLog(sandbox, target.title, "结论", doneDetail);
      emitStep(onProgress, "arbitrateSelection", "pick", badIdDetail);
      emitStep(onProgress, "reportNoCoverage", "finalize", doneDetail);
      return concludeUncovered(sandbox, {
        text: `仲裁返回非法候选:${current}`,
        steps: 0,
        escalated,
        reason: `仲裁返回非法候选 id（不在快照中）:${current}`,
      });
    }
    const pickedDetail = `选中候选 ${current}${arbitration.reasoning ? `(${arbitration.reasoning})` : ""}`;
    stepLog(sandbox, target.title, "仲裁", pickedDetail);
    emitStep(onProgress, "arbitrateSelection", "pick", pickedDetail);
  }

  // 3. Transfer → digest → finalize / diagnose, with limited retries for dead
  //    links and off-target packs. A dead link (nothing landed) is a CHEAP
  //    fail-loud probe — it must NOT consume the transfer-attempt budget, so it
  //    is counted separately (MAX_DEAD_LINK_RETRIES) and only a real materialized
  //    transfer (attempted) counts toward MAX_TRANSFER_ATTEMPTS.
  const attempted = new Set<string>();
  const tried = new Set<string>();
  let deadRetries = 0;
  while (
    current !== null &&
    attempted.size < MAX_TRANSFER_ATTEMPTS &&
    deadRetries < MAX_DEAD_LINK_RETRIES
  ) {
    tried.add(current);
    const transferDetail = `候选 ${current}(第 ${attempted.size + 1}/${MAX_TRANSFER_ATTEMPTS} 次转存)`;
    stepLog(sandbox, target.title, "转存", transferDetail);
    emitStep(onProgress, "transferCandidate", "transfer", transferDetail, { candidateId: current });
    const transfer = await sandbox.transferCandidate({
      snapshotId: raw.snapshotId,
      candidateId: current,
    });

    // Systemic block (quota/auth/VIP) — every remaining candidate fails the same
    // way; stop grinding.
    if (transfer.systemicBlock) {
      const blockDetail = `系统阻塞:${transfer.systemicBlock.reason}`;
      stepLog(sandbox, target.title, "转存失败", blockDetail, "error");
      const doneDetail = `失败(系统阻塞:${transfer.systemicBlock.reason})`;
      stepLog(sandbox, target.title, "结论", doneDetail);
      emitStep(onProgress, "transferCandidate", "transfer", blockDetail);
      emitStep(onProgress, "finish", "finalize", doneDetail);
      return {
        text: `系统阻塞:${transfer.systemicBlock.reason}`,
        steps: attempted.size,
        coverage: await sandbox.finish(),
        escalated,
      };
    }

    // Dead link (nothing landed) — a cheap probe, not a transfer attempt; advance
    // to the next candidate until the dead-link scan cap or the pool is exhausted.
    if (transfer.staging.length === 0) {
      deadRetries += 1;
      const next = nextCandidate(grading, tried);
      const deadDetail = `候选 ${current} 死链(未落盘)${next ? `,死链重试换候选 ${next}(${deadRetries}/${MAX_DEAD_LINK_RETRIES})` : ",无下一候选"}`;
      stepLog(sandbox, target.title, "转存失败", deadDetail, "warn");
      emitStep(onProgress, "transferCandidate", "transfer", deadDetail, { candidateId: current });
      current = next;
      continue;
    }

    // A real transfer happened — this is the countable attempt.
    attempted.add(current);
    const digest = digestStaging({ files: transfer.staging, seasons, needCodes });
    const digestDetail = digest.passes
      ? `干净落地,覆盖 ${digest.coveredCodes.join(",") || "-"}`
      : `未通过(${digest.isDirtyPack ? "脏包" : "未覆盖目标"}):${digest.summary.split("\n").join(" / ")}`;
    stepLog(
      sandbox,
      target.title,
      "digest 验证",
      digestDetail,
      digest.passes ? "log" : "warn",
    );
    emitStep(onProgress, "stagingDigest", "verify", digestDetail);

    // Clean landing → finalize (rename/归位/mark/wipe) in code, zero LLM.
    if (digest.passes) {
      try {
        const finalized = await finalizeLanding({ sandbox, digest, canonicalTitle: target.title, seasons });
        const organizeDetail = `标记 ${finalized.marked.join(",") || "-"} / 移动 ${Object.values(finalized.movedSeasons).reduce((sum, n) => sum + n, 0)} 文件 / 清理 ${finalized.discarded.length} 文件`;
        stepLog(sandbox, target.title, "归位", organizeDetail);
        emitStep(onProgress, "finalizeLanding", "organize", organizeDetail);
      } catch (error) {
        // A rename/move guard refused, or storage failed mid-landing — nothing was
        // reliably placed. Wipe staging and surface honest no-coverage (never a
        // fake obtained mark), mirroring the agent's honest termination.
        try {
          await sandbox.discardStaging();
        } catch {
          // staging already empty / no separate staging — nothing to wipe.
        }
        const organizeFailDetail = error instanceof Error ? error.message : String(error);
        stepLog(sandbox, target.title, "归位失败", organizeFailDetail, "error");
        emitStep(onProgress, "finalizeLanding", "organize", organizeFailDetail);
        const doneDetail = `失败(归位异常:${error instanceof Error ? error.message : String(error)})`;
        stepLog(sandbox, target.title, "结论", doneDetail);
        emitStep(onProgress, "reportNoCoverage", "finalize", doneDetail);
        return concludeUncovered(sandbox, {
          text: `fast path 归位失败:${error instanceof Error ? error.message : String(error)}`,
          steps: attempted.size,
          escalated,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      const doneDetail = `入库(obtained=${digest.coveredCodes.join(",") || "-"})`;
      stepLog(sandbox, target.title, "结论", doneDetail);
      emitStep(onProgress, "finish", "finalize", doneDetail);
      return {
        text: `fast path 归位标记:${digest.coveredCodes.join(",") || "-"}`,
        steps: attempted.size,
        coverage: await sandbox.finish(),
        escalated,
      };
    }

    // Dirty / off-target landing → diagnostic arbitration (escalation #2).
    escalated = true;
    const diagnosis = await arbitrateDiagnosis({
      model,
      summary: digest.summary,
      title: target.title,
    });
    if (diagnosis.action === "accept") {
      try {
        await finalizeLanding({ sandbox, digest, canonicalTitle: target.title, seasons });
      } catch (error) {
        try {
          await sandbox.discardStaging();
        } catch {
          // already empty.
        }
        const organizeFailDetail = error instanceof Error ? error.message : String(error);
        stepLog(sandbox, target.title, "归位失败", organizeFailDetail, "error");
        emitStep(onProgress, "finalizeLanding", "organize", organizeFailDetail);
        const doneDetail = `失败(归位异常:${error instanceof Error ? error.message : String(error)})`;
        stepLog(sandbox, target.title, "结论", doneDetail);
        emitStep(onProgress, "reportNoCoverage", "finalize", doneDetail);
        return concludeUncovered(sandbox, {
          text: `fast path 归位失败:${error instanceof Error ? error.message : String(error)}`,
          steps: attempted.size,
          escalated,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      const doneDetail = `入库(仲裁 accept:${diagnosis.reasoning})`;
      stepLog(sandbox, target.title, "结论", doneDetail);
      emitStep(onProgress, "finish", "finalize", doneDetail);
      return {
        text: `仲裁 accept:${diagnosis.reasoning}`,
        steps: attempted.size,
        coverage: await sandbox.finish(),
        escalated,
      };
    }
    if (diagnosis.action === "abandon") {
      await sandbox.discardStaging();
      const declineDetail = `放弃:${diagnosis.reasoning}`;
      stepLog(sandbox, target.title, "仲裁", declineDetail, "warn");
      const doneDetail = `暂无资源(仲裁 abandon:${diagnosis.reasoning})`;
      stepLog(sandbox, target.title, "结论", doneDetail);
      emitStep(onProgress, "arbitrateDiagnosis", "pick", declineDetail);
      emitStep(onProgress, "reportNoCoverage", "finalize", doneDetail);
      return concludeUncovered(sandbox, {
        text: `仲裁 abandon:${diagnosis.reasoning}`,
        steps: attempted.size,
        escalated,
        reason: diagnosis.reasoning,
      });
    }
    // retry_other → clear the bad pack's files (keep the staging dir alive) and
    // try the next candidate.
    const leftover = await sandbox.inspectStaging();
    if (leftover.length > 0) {
      await sandbox.deleteFiles({ directory: "staging", fileIds: leftover.map((f) => f.id) });
    }
    const next = nextCandidate(grading, tried);
    const retryDetail = `off-target 重试:丢弃当前落地,换候选 ${next ?? "无(终止)"}`;
    stepLog(sandbox, target.title, "仲裁", retryDetail, "warn");
    emitStep(onProgress, "arbitrateDiagnosis", "pick", retryDetail);
    current = next;
  }

  // Candidates exhausted or attempt cap hit → wipe staging and report unmet.
  if ((await sandbox.inspectStaging()).length > 0) {
    await sandbox.discardStaging();
  }
  const exhaustedDetail = `缺集(尝试 ${attempted.size} 次转存,扫过 ${tried.size} 个候选仍未覆盖)`;
  stepLog(sandbox, target.title, "结论", exhaustedDetail);
  emitStep(onProgress, "reportNoCoverage", "finalize", exhaustedDetail);
  return {
    text: `fast path 未覆盖(尝试 ${attempted.size} 次转存)`,
    steps: attempted.size,
    coverage: await sandbox.finish(),
    escalated,
  };
}

/** The movie fast path (§6.5 sibling): the film's happy path runs in CODE, with
 *  the LLM demoted to the movie arbitrator's two single-call judgments. Flow:
 *
 *   landing-point check (film already in dir → mark MOVIE) →
 *     grade (title + year, code) → unique A ? transfer : arbitrateMovieSelection →
 *     transfer → movie digest (ONE film?) → passes ? flatten+mark : arbitrateMovieDiagnosis
 *
 *  A clean run (a unique A-grade film that lands and digests as one film) makes
 *  ZERO LLM calls. Genuine ambiguity — no unique A-grade, or a landing that is not
 *  one clean film — escalates one judgment call at a time.
 *
 *  Scope is VIDEO ONLY: a 中字/软兜底 order (foreign film + 中文 subtitle preference)
 *  is routed to the LLM movie agent by the orchestrator BEFORE reaching here — this
 *  module never writes a deterministic subtitle selector.
 */

export interface MovieFastPathOptions {
  sandbox: TaskSandbox;
  model: LanguageModel;
  target: MovieTarget;
  /** Live step trace for the activity page (Task D) — same contract as FastPathOptions. */
  onProgress?: (event: AgentToolEvent) => void;
}

export interface MovieFastPathResult {
  text: string;
  steps: number;
  coverage: { coverageMet: boolean; obtained: string[]; missing: string[]; subtitleFallback: boolean };
  escalated: boolean;
}

/** Clear a movie landing's files WITHOUT wiping the movie dir (staging === movie
 *  dir, so discardStaging is refused). Leftover empty wrapper dirs are peeled by
 *  the next successful flattenMovie. */
async function clearMovieLanding(sandbox: TaskSandbox): Promise<void> {
  const leftover = await sandbox.inspectStaging();
  if (leftover.length > 0) {
    await sandbox.deleteFiles({ directory: "staging", fileIds: leftover.map((f) => f.id) });
  }
}

export async function runMovieFastPathAcquisition(
  options: MovieFastPathOptions,
): Promise<MovieFastPathResult> {
  const { sandbox, model, target, onProgress } = options;

  // 0. Landing-point check FIRST (movie has no episode codes): if the movie dir
  //    already holds a VIDEO (a prior run placed the film, or a crash left it
  //    mid-flight), mark MOVIE obtained and finish — never re-search/re-transfer.
  const onDisk = await sandbox.inspectTargetDir();
  if (onDisk.some((file) => file.isVideo)) {
    emitStep(onProgress, "inspectTargetDir", "search", "影片已在库(MOVIE)");
    await sandbox.markObtained({ codes: ["MOVIE"] });
    emitStep(onProgress, "markObtained", "mark", "影片已入库(MOVIE)", { codes: ["MOVIE"] });
    const doneDetail = "入库:已在库(MOVIE)";
    stepLog(sandbox, target.title, "落点检查", "影片已在库(MOVIE)");
    stepLog(sandbox, target.title, "结论", doneDetail);
    emitStep(onProgress, "finish", "finalize", doneDetail);
    return {
      text: "fast path 已在库:MOVIE",
      steps: 0,
      coverage: await sandbox.finish(),
      escalated: false,
    };
  }
  const landingDetail = "目标目录无影片,开始获取";
  stepLog(sandbox, target.title, "落点检查", landingDetail);
  emitStep(onProgress, "inspectTargetDir", "search", landingDetail);

  // 1. Grade the primed raw-snapshot candidates (code, zero LLM): identity is
  //    title + release year.
  let raw = sandbox.rawSnapshotView();
  if (!raw) {
    const snapshotDetail = "无(搜索源未响应)";
    stepLog(sandbox, target.title, "预搜快照", snapshotDetail, "warn");
    emitStep(onProgress, "viewResourceSnapshot", "search", snapshotDetail);
    const doneDetail = "暂无资源(搜索源未响应)";
    stepLog(sandbox, target.title, "结论", doneDetail);
    emitStep(onProgress, "reportNoCoverage", "finalize", doneDetail);
    return {
      text: "无预搜快照(搜索源未响应)",
      steps: 0,
      coverage: await sandbox.finish(),
      escalated: false,
    };
  }
  const snapshotDetail =
    raw.candidates.length === 0 ? "候选 0 条(快照为空)" : `候选 ${raw.candidates.length} 条`;
  stepLog(sandbox, target.title, "预搜快照", snapshotDetail, raw.candidates.length === 0 ? "warn" : "log");
  emitStep(onProgress, "viewResourceSnapshot", "search", snapshotDetail);

  let grading = gradeCandidates(raw.candidates, {
    title: target.title,
    aliases: target.aliases,
    seasons: [],
    year: target.year,
  });

  // 1b. Aliases 兜底重搜 (movie twin of the TV §C fallback): when the primary
  //     search by target.title comes back empty, or grades without a unique A
  //     (title + year), re-search with each alias until a unique A-grade appears
  //     or the budget (≤3 rounds) runs out. primeRawSnapshot OVERWRITES the
  //     snapshot — grading/arbitration/transfer after a fallback read the NEW
  //     evidence, unless the whole fallback fails AND primary had candidates
  //     (§E: restore the primary evidence instead of discarding it).
  if ((raw.candidates.length === 0 || !grading.uniqueTopGrade) && target.aliases.length > 0) {
    const fallback = await aliasesFallbackReSearch({
      sandbox,
      title: target.title,
      aliases: target.aliases,
      view: raw,
      grading,
      ...(onProgress ? { onProgress } : {}),
      grade: (candidates) =>
        gradeCandidates(candidates, {
          title: target.title,
          aliases: target.aliases,
          seasons: [],
          year: target.year,
        }),
    });
    raw = fallback.view;
    grading = fallback.grading;
  }

  if (raw.candidates.length === 0) {
    const doneDetail = "暂无资源(快照为空)";
    stepLog(sandbox, target.title, "结论", doneDetail);
    emitStep(onProgress, "reportNoCoverage", "finalize", doneDetail);
    return concludeUncovered(sandbox, {
      text: "无候选(raw snapshot 为空)",
      steps: 0,
      escalated: false,
      reason: "raw snapshot 为空",
    });
  }

  const gradeCounts = { A: 0, B: 0, C: 0, D: 0 };
  for (const candidate of grading.ranked) gradeCounts[candidate.grade] += 1;
  const gradingDetail = `(年份判据 ${target.year ?? "未知"}) A ${gradeCounts.A} / B ${gradeCounts.B} / C ${gradeCounts.C} / D ${gradeCounts.D}`;
  stepLog(sandbox, target.title, "评分", gradingDetail);
  emitStep(onProgress, "gradeCandidates", "search", gradingDetail);

  // 2. Pick the first candidate: a unique A-grade (title + year match) transfers
  //    blind; otherwise the movie selection arbitrator picks one (escalation #1).
  let escalated = false;
  let current: string | null;
  if (grading.uniqueTopGrade && grading.top) {
    current = grading.top.id;
    const pickDetail = `唯一 A 盲转:候选 ${current}(${grading.top.title})`;
    stepLog(sandbox, target.title, "选片", pickDetail);
    emitStep(onProgress, "pickCandidate", "pick", pickDetail);
  } else {
    escalated = true;
    const arbitration = await arbitrateMovieSelection({
      model,
      summary: summarizeGrading(grading),
      title: target.title,
      year: target.year,
    });
    current = arbitration.candidateId;
    if (current === null) {
      const declineDetail = `放弃:${arbitration.reasoning || "无可用候选"}`;
      stepLog(sandbox, target.title, "仲裁", declineDetail, "warn");
      const doneDetail = `暂无资源(仲裁放弃:${arbitration.reasoning || "无可用候选"})`;
      stepLog(sandbox, target.title, "结论", doneDetail);
      emitStep(onProgress, "arbitrateSelection", "pick", declineDetail);
      emitStep(onProgress, "reportNoCoverage", "finalize", doneDetail);
      return concludeUncovered(sandbox, {
        text: `仲裁放弃:${arbitration.reasoning || "无可用候选"}`,
        steps: 0,
        escalated,
        reason: arbitration.reasoning || "无可用候选",
      });
    }
    // Defense-in-depth: the model only sees the graded summary and may return a
    // TITLE or a made-up id instead of a real candidate id. A bogus id must never
    // reach transferCandidate's SANDBOX_CANDIDATE_NOT_IN_SNAPSHOT throw and blow
    // up the whole run — treat it like a declined arbitration (safe uncover).
    if (!raw.candidates.some((candidate) => candidate.id === current)) {
      const badIdDetail = `返回非法候选 id:${current}`;
      stepLog(sandbox, target.title, "仲裁", badIdDetail, "error");
      const doneDetail = `暂无资源(仲裁返回非法候选:${current})`;
      stepLog(sandbox, target.title, "结论", doneDetail);
      emitStep(onProgress, "arbitrateSelection", "pick", badIdDetail);
      emitStep(onProgress, "reportNoCoverage", "finalize", doneDetail);
      return concludeUncovered(sandbox, {
        text: `仲裁返回非法候选:${current}`,
        steps: 0,
        escalated,
        reason: `仲裁返回非法候选 id（不在快照中）:${current}`,
      });
    }
    const pickedDetail = `选中候选 ${current}${arbitration.reasoning ? `(${arbitration.reasoning})` : ""}`;
    stepLog(sandbox, target.title, "仲裁", pickedDetail);
    emitStep(onProgress, "arbitrateSelection", "pick", pickedDetail);
  }

  // 3. Transfer → movie digest → flatten+mark / diagnose, with limited dead-link
  //    retries (same transferUntilLanded ceiling as TV). A dead link (nothing
  //    landed) is a CHEAP fail-loud probe — counted separately, NOT as a transfer
  //    attempt; only a real materialized transfer (attempted) counts toward
  //    MAX_TRANSFER_ATTEMPTS.
  const attempted = new Set<string>();
  const tried = new Set<string>();
  let deadRetries = 0;
  while (
    current !== null &&
    attempted.size < MAX_TRANSFER_ATTEMPTS &&
    deadRetries < MAX_DEAD_LINK_RETRIES
  ) {
    tried.add(current);
    const transferDetail = `候选 ${current}(第 ${attempted.size + 1}/${MAX_TRANSFER_ATTEMPTS} 次转存)`;
    stepLog(sandbox, target.title, "转存", transferDetail);
    emitStep(onProgress, "transferCandidate", "transfer", transferDetail, { candidateId: current });
    const transfer = await sandbox.transferCandidate({
      snapshotId: raw.snapshotId,
      candidateId: current,
    });

    if (transfer.systemicBlock) {
      const blockDetail = `系统阻塞:${transfer.systemicBlock.reason}`;
      stepLog(sandbox, target.title, "转存失败", blockDetail, "error");
      const doneDetail = `失败(系统阻塞:${transfer.systemicBlock.reason})`;
      stepLog(sandbox, target.title, "结论", doneDetail);
      emitStep(onProgress, "transferCandidate", "transfer", blockDetail);
      emitStep(onProgress, "finish", "finalize", doneDetail);
      return {
        text: `系统阻塞:${transfer.systemicBlock.reason}`,
        steps: attempted.size,
        coverage: await sandbox.finish(),
        escalated,
      };
    }

    // Dead link (nothing landed) → a cheap probe, not a transfer attempt; advance
    // to the next candidate until the dead-link scan cap or the pool is exhausted.
    if (transfer.staging.length === 0) {
      deadRetries += 1;
      const next = nextCandidate(grading, tried);
      const deadDetail = `候选 ${current} 死链(未落盘)${next ? `,死链重试换候选 ${next}(${deadRetries}/${MAX_DEAD_LINK_RETRIES})` : ",无下一候选"}`;
      stepLog(sandbox, target.title, "转存失败", deadDetail, "warn");
      emitStep(onProgress, "transferCandidate", "transfer", deadDetail, { candidateId: current });
      current = next;
      continue;
    }

    // A real transfer happened — this is the countable attempt.
    attempted.add(current);
    const digest = digestMovieStaging(transfer.staging);

    // Nothing landed as a video (subtitle-only / stray) → clear the residue and
    // advance like a dead link. Without the clear, the stray subtitles/nfo would
    // linger in the movie dir and ride the NEXT candidate's flatten (renamed and
    // kept as if they were this film's).
    if (digest.videos.length === 0) {
      await clearMovieLanding(sandbox);
      const next = nextCandidate(grading, tried);
      const noVideoDetail = `未落盘视频(仅字幕/杂项),清空后换候选 ${next ?? "无(终止)"}`;
      stepLog(sandbox, target.title, "digest 验证", noVideoDetail, "warn");
      emitStep(onProgress, "stagingDigest", "verify", noVideoDetail);
      current = next;
      continue;
    }

    const digestDetail = digest.passes
      ? `一部正片(视频 ${digest.videos.length} / 字幕 ${digest.subtitles.length})`
      : `未通过(${digest.isDirtyPack ? "非单部正片/脏包" : "无视频"}):${digest.summary.split("\n").join(" / ")}`;
    stepLog(
      sandbox,
      target.title,
      "digest 验证",
      digestDetail,
      digest.passes ? "log" : "warn",
    );
    emitStep(onProgress, "stagingDigest", "verify", digestDetail);

    // One clean film → flatten + mark in code, zero LLM.
    if (digest.passes) {
      try {
        const finalized = await finalizeMovieLanding({ sandbox, digest });
        const organizeDetail = `flatten+标记 ${finalized.marked.join(",") || "-"}`;
        stepLog(sandbox, target.title, "归位", organizeDetail);
        emitStep(onProgress, "finalizeLanding", "organize", organizeDetail);
      } catch (error) {
        await clearMovieLanding(sandbox).catch(() => {});
        const organizeFailDetail = error instanceof Error ? error.message : String(error);
        stepLog(sandbox, target.title, "归位失败", organizeFailDetail, "error");
        emitStep(onProgress, "finalizeLanding", "organize", organizeFailDetail);
        const doneDetail = `失败(归位异常:${error instanceof Error ? error.message : String(error)})`;
        stepLog(sandbox, target.title, "结论", doneDetail);
        emitStep(onProgress, "reportNoCoverage", "finalize", doneDetail);
        return concludeUncovered(sandbox, {
          text: `fast path 归位失败:${error instanceof Error ? error.message : String(error)}`,
          steps: attempted.size,
          escalated,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      const doneDetail = "入库(MOVIE)";
      stepLog(sandbox, target.title, "结论", doneDetail);
      emitStep(onProgress, "finish", "finalize", doneDetail);
      return {
        text: "fast path 归位标记:MOVIE",
        steps: attempted.size,
        coverage: await sandbox.finish(),
        escalated,
      };
    }

    // Not one clean film → diagnostic arbitration (escalation #2).
    escalated = true;
    const diagnosis = await arbitrateMovieDiagnosis({
      model,
      summary: digest.summary,
      title: target.title,
      year: target.year,
    });
    if (diagnosis.action === "accept") {
      try {
        await finalizeMovieLanding({ sandbox, digest });
      } catch (error) {
        await clearMovieLanding(sandbox).catch(() => {});
        const organizeFailDetail = error instanceof Error ? error.message : String(error);
        stepLog(sandbox, target.title, "归位失败", organizeFailDetail, "error");
        emitStep(onProgress, "finalizeLanding", "organize", organizeFailDetail);
        const doneDetail = `失败(归位异常:${error instanceof Error ? error.message : String(error)})`;
        stepLog(sandbox, target.title, "结论", doneDetail);
        emitStep(onProgress, "reportNoCoverage", "finalize", doneDetail);
        return concludeUncovered(sandbox, {
          text: `fast path 归位失败:${error instanceof Error ? error.message : String(error)}`,
          steps: attempted.size,
          escalated,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      const doneDetail = `入库(仲裁 accept:${diagnosis.reasoning})`;
      stepLog(sandbox, target.title, "结论", doneDetail);
      emitStep(onProgress, "finish", "finalize", doneDetail);
      return {
        text: `仲裁 accept:${diagnosis.reasoning}`,
        steps: attempted.size,
        coverage: await sandbox.finish(),
        escalated,
      };
    }
    if (diagnosis.action === "abandon") {
      await clearMovieLanding(sandbox);
      const declineDetail = `放弃:${diagnosis.reasoning}`;
      stepLog(sandbox, target.title, "仲裁", declineDetail, "warn");
      const doneDetail = `暂无资源(仲裁 abandon:${diagnosis.reasoning})`;
      stepLog(sandbox, target.title, "结论", doneDetail);
      emitStep(onProgress, "arbitrateDiagnosis", "pick", declineDetail);
      emitStep(onProgress, "reportNoCoverage", "finalize", doneDetail);
      return concludeUncovered(sandbox, {
        text: `仲裁 abandon:${diagnosis.reasoning}`,
        steps: attempted.size,
        escalated,
        reason: diagnosis.reasoning,
      });
    }
    // retry_other → clear the bad landing's files and try the next candidate.
    await clearMovieLanding(sandbox);
    const next = nextCandidate(grading, tried);
    const retryDetail = `off-target 重试:丢弃当前落地,换候选 ${next ?? "无(终止)"}`;
    stepLog(sandbox, target.title, "仲裁", retryDetail, "warn");
    emitStep(onProgress, "arbitrateDiagnosis", "pick", retryDetail);
    current = next;
  }

  // Candidates exhausted or attempt cap hit → clear the leftover landing and
  // report unmet (a wrong film must NOT linger to be mis-read as obtained next
  // patrol).
  await clearMovieLanding(sandbox);
  const exhaustedDetail = `缺集(尝试 ${attempted.size} 次转存,扫过 ${tried.size} 个候选仍未覆盖)`;
  stepLog(sandbox, target.title, "结论", exhaustedDetail);
  emitStep(onProgress, "reportNoCoverage", "finalize", exhaustedDetail);
  return {
    text: `fast path 未覆盖(尝试 ${attempted.size} 次转存)`,
    steps: attempted.size,
    coverage: await sandbox.finish(),
    escalated,
  };
}
