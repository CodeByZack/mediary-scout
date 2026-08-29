import type { LanguageModel } from "ai";
import {
  arbitrateMovieDiagnosis,
  arbitrateMovieSelection,
} from "../../acquisition-v2/arbitrator.js";
import { gradeCandidates, summarizeGrading } from "../../acquisition-v2/candidate-grader.js";
import { finalizeMovieLanding } from "../../acquisition-v2/finalize-landing.js";
import type { AgentToolEvent } from "../../acquisition-v2/activity.js";
import type { TaskSandbox } from "../../acquisition-v2/sandbox.js";
import { digestMovieStaging } from "../../acquisition-v2/staging-digest.js";
import type { MovieTarget } from "../../acquisition-v2/task-agents.js";
import { pickSubtitle } from "../../acquisition-v2/subtitle-picker.js";
import type { AssrtProviderPort } from "../../subtitle-provider.js";
import { MAX_DEAD_LINK_RETRIES, MAX_TRANSFER_ATTEMPTS } from "./budgets.js";
import {
  aliasesFallbackReSearch,
  candidateSnapshotId,
  type EvidenceView,
} from "./landing.js";
import {
  concludeUncovered,
  emitStep,
  evidenceDigestLine,
  logStorageProvider,
  nextCandidate,
  stepLog,
} from "./steps.js";

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
 *  Scope: video-first, with an OPTIONAL deterministic subtitle stage for NON-CN
 *  films whose drive can land external subtitles (assrt 选包 via subtitle-picker.ts,
 *  zero LLM). 国产片 or drives without subtitle capability get pure-video runs —
 *  the 中字 preference degrades to best-effort, never blocks.
 */

export interface MovieFastPathOptions {
  sandbox: TaskSandbox;
  model: LanguageModel;
  target: MovieTarget;
  /** The run's drive brand ("pan115" | "quark" | …) — printed at the top of the
   *  run so the log shows which 网盘 this task is writing to. */
  storageProvider?: string;
  /** Live step trace for the activity page (Task D) — same contract as FastPathOptions. */
  onProgress?: (event: AgentToolEvent) => void;
  /** Optional subtitle stage — ONLY wired by the orchestrator for NON-CN films
   *  whose drive can actually land external subtitles (assrt token + executor
   *  capability). When present, the fast path, AFTER the video lands, primes the
   *  assrt snapshot, picks a package deterministically (subtitle-picker.ts), and
   *  lands it — then flattenMovie auto-renames video + subtitles together.
   *  Absent = pure-video fast path (国产片 natively Chinese-spoken — no 中字 to
   *  hunt; or the drive cannot land subtitles — preference degrades to best-effort). */
  subtitle?: {
    provider: AssrtProviderPort;
    preferredLanguage: string;
  };
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

/**
 * Movie subtitle stage (zero-LLM): AFTER the video landed cleanly, land ONE
 * assrt subtitle package picked deterministically, then let flattenMovie
 * auto-rename video + subtitles together to `Title (Year).ext`.
 *
 * Soft target: any failure here (provider miss, no candidates, package with no
 * usable files, landing errors) logs a warning and proceeds with the video
 * ALONE — subtitles never block the film.
 *
 * Flow: primes the assrt snapshot via the sandbox (idempotent, soft-fails to an
 * empty list) → picks the best package (subtitle-picker) → transferSubtitle
 * lands its files into staging → flattenMovie (called by the caller AFTER this)
 * lifts + renames them beside the video. The picked package's files carry
 * .sc/.tc 简繁 infixes that flatten's canonical rename preserves.
 */
async function landSubtitlesForMovie(options: {
  sandbox: TaskSandbox;
  title: string;
  subtitle: NonNullable<MovieFastPathOptions["subtitle"]>;
  onProgress?: (event: AgentToolEvent) => void;
}): Promise<void> {
  const { sandbox, title, subtitle, onProgress } = options;
  try {
    // 1. Read the pre-warmed assrt snapshot. The orchestrator primes it BEFORE
    //    dispatch (same gate: non-CN + capable drive), so read-only first — an
    //    EMPTY list here is usually "already primed & empty", not "unprimed".
    //    Only when nothing is primed at all (direct fast-path callers without
    //    the orchestrator's pre-warm) do we prime ourselves — never double-hit
    //    the shared assrt quota (20/min).
    let candidates = sandbox.subtitleCandidates();
    if (candidates.length === 0 && sandbox.viewSubtitleSnapshot().candidateCount === 0) {
      // Unprimed OR primed-empty are indistinguishable from the read side;
      // priming again is harmless (idempotent overwrite) and only happens when
      // the orchestrator path was skipped. Cost: one assrt search.
      await sandbox.primeSubtitleSnapshot(title, subtitle.provider);
      candidates = sandbox.subtitleCandidates();
    }
    stepLog(sandbox, title, "字幕", `assrt 候选 ${candidates.length} 条`);
    emitStep(onProgress, "viewSubtitleSnapshot", "pick", `assrt 候选 ${candidates.length} 条`);
    if (candidates.length === 0) {
      return; // no packages — video alone is fine
    }

    // 2. Deterministically pick ONE package.
    const pick = pickSubtitle(candidates, {
      preferredLanguage: subtitle.preferredLanguage,
    });
    if (!pick.picked) {
      stepLog(sandbox, title, "字幕", pick.reason, "warn");
      emitStep(onProgress, "viewSubtitleSnapshot", "pick", pick.reason);
      return;
    }
    stepLog(sandbox, title, "字幕", pick.reason);
    emitStep(onProgress, "viewSubtitleSnapshot", "pick", pick.reason);

    // 3. Land its files into staging (soft-fail).
    const landed = await sandbox.transferSubtitle({ candidateId: pick.picked.id });
    if (landed.status === "succeeded") {
      stepLog(sandbox, title, "字幕", `落地 ${landed.landedFilenames.length} 个字幕文件`);
      emitStep(onProgress, "transferSubtitle", "pick", `落地 ${landed.landedFilenames.length} 个字幕文件`);
    } else {
      stepLog(sandbox, title, "字幕", `落地失败:${landed.error ?? "无文件落盘"}`, "warn");
      emitStep(onProgress, "transferSubtitle", "pick", `落地失败:${landed.error ?? "无文件落盘"}`);
    }
  } catch (error) {
    // Never block the video on a subtitle hiccup.
    const message = error instanceof Error ? error.message : String(error);
    stepLog(sandbox, title, "字幕", `阶段异常:${message}`, "warn");
    emitStep(onProgress, "viewSubtitleSnapshot", "pick", `字幕阶段异常:${message}`);
  }
}

export async function runMovieFastPathAcquisition(
  options: MovieFastPathOptions,
): Promise<MovieFastPathResult> {
  const { sandbox, model, target, subtitle, onProgress } = options;
  logStorageProvider(sandbox, target.title, options.storageProvider);

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
  let raw: EvidenceView | null = sandbox.rawSnapshotView();
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
  stepLog(sandbox, target.title, "评分摘要", evidenceDigestLine(grading));
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
      snapshotId: candidateSnapshotId(raw, current),
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
      // Subtitle stage (optional, non-CN + capable drive only): land the
      // deterministically-picked assrt package BEFORE flatten, so flattenMovie
      // lifts + renames video AND subtitles together to `Title (Year).ext`.
      if (subtitle) {
        await landSubtitlesForMovie({
          sandbox,
          title: target.title,
          subtitle,
          ...(onProgress ? { onProgress } : {}),
        });
      }
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
      // Same subtitle stage as the clean-pass: land subtitles before flatten so
      // video + subtitles get renamed together.
      if (subtitle) {
        await landSubtitlesForMovie({
          sandbox,
          title: target.title,
          subtitle,
          ...(onProgress ? { onProgress } : {}),
        });
      }
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
