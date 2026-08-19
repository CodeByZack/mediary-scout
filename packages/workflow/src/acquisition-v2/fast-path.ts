import type { LanguageModel } from "ai";
import { episodeCodeFromFileName } from "../episode-code.js";
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

export interface FastPathOptions {
  sandbox: TaskSandbox;
  model: LanguageModel;
  target: TvAnimeTarget;
  /** CN-origin works are natively Chinese-spoken → no 中字 gate in grading. */
  isChineseNative: boolean;
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

export async function runFastPathAcquisition(options: FastPathOptions): Promise<FastPathResult> {
  const { sandbox, model, target, isChineseNative } = options;
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
    await sandbox.markObtained({ codes: [...alreadyPresent] });
    needCodes = needCodes.filter((code) => !alreadyPresent.has(code));
  }
  if (needCodes.length === 0) {
    // The library already holds the whole need — no search, no transfer, no LLM.
    return {
      text: `fast path 已在库:${[...alreadyPresent].join(",")}`,
      steps: 0,
      coverage: await sandbox.finish(),
      escalated: false,
    };
  }

  // 1. Grade the primed raw-snapshot candidates (code, zero LLM).
  const raw = sandbox.rawSnapshotView();
  if (!raw) {
    // The raw pre-warm never landed (search source down) — there is NO evidence
    // base, so reportNoCoverage would throw SANDBOX_NO_PROVIDER_EVIDENCE (its
    // §9 guard: no search ran). Surface the source fault as uncovered, not as
    // "no resource".
    return {
      text: "无预搜快照(搜索源未响应)",
      steps: 0,
      coverage: await sandbox.finish(),
      escalated: false,
    };
  }
  if (raw.candidates.length === 0) {
    return concludeUncovered(sandbox, {
      text: "无候选(raw snapshot 为空)",
      steps: 0,
      escalated: false,
      reason: "raw snapshot 为空",
    });
  }

  const grading = gradeCandidates(raw.candidates, {
    title: target.title,
    aliases: target.aliases,
    seasons,
    isChineseNative,
  });

  // 2. Pick the first candidate: a unique A-grade transfers blind; otherwise the
  //    selection arbitrator picks one (escalation #1).
  let escalated = false;
  let current: string | null;
  if (grading.uniqueTopGrade && grading.top) {
    current = grading.top.id;
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
      return concludeUncovered(sandbox, {
        text: `仲裁放弃:${arbitration.reasoning || "无可用候选"}`,
        steps: 0,
        escalated,
        reason: arbitration.reasoning || "无可用候选",
      });
    }
  }

  // 3. Transfer → digest → finalize / diagnose, with limited retries for dead
  //    links and off-target packs.
  const attempted = new Set<string>();
  while (current !== null && attempted.size < MAX_TRANSFER_ATTEMPTS) {
    attempted.add(current);
    const transfer = await sandbox.transferCandidate({
      snapshotId: raw.snapshotId,
      candidateId: current,
    });

    // Systemic block (quota/auth/VIP) — every remaining candidate fails the same
    // way; stop grinding.
    if (transfer.systemicBlock) {
      return {
        text: `系统阻塞:${transfer.systemicBlock.reason}`,
        steps: attempted.size,
        coverage: await sandbox.finish(),
        escalated,
      };
    }

    // Dead link (nothing landed) — advance to the next candidate.
    if (transfer.staging.length === 0) {
      current = nextCandidate(grading, attempted);
      continue;
    }

    const digest = digestStaging({ files: transfer.staging, seasons, needCodes });

    // Clean landing → finalize (rename/归位/mark/wipe) in code, zero LLM.
    if (digest.passes) {
      try {
        await finalizeLanding({ sandbox, digest, canonicalTitle: target.title, seasons });
      } catch (error) {
        // A rename/move guard refused, or storage failed mid-landing — nothing was
        // reliably placed. Wipe staging and surface honest no-coverage (never a
        // fake obtained mark), mirroring the agent's honest termination.
        try {
          await sandbox.discardStaging();
        } catch {
          // staging already empty / no separate staging — nothing to wipe.
        }
        return concludeUncovered(sandbox, {
          text: `fast path 归位失败:${error instanceof Error ? error.message : String(error)}`,
          steps: attempted.size,
          escalated,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
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
        return concludeUncovered(sandbox, {
          text: `fast path 归位失败:${error instanceof Error ? error.message : String(error)}`,
          steps: attempted.size,
          escalated,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      return {
        text: `仲裁 accept:${diagnosis.reasoning}`,
        steps: attempted.size,
        coverage: await sandbox.finish(),
        escalated,
      };
    }
    if (diagnosis.action === "abandon") {
      await sandbox.discardStaging();
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
    current = nextCandidate(grading, attempted);
  }

  // Candidates exhausted or attempt cap hit → wipe staging and report unmet.
  if ((await sandbox.inspectStaging()).length > 0) {
    await sandbox.discardStaging();
  }
  return {
    text: `fast path 未覆盖(尝试 ${attempted.size} 个候选)`,
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
  const { sandbox, model, target } = options;

  // 0. Landing-point check FIRST (movie has no episode codes): if the movie dir
  //    already holds a VIDEO (a prior run placed the film, or a crash left it
  //    mid-flight), mark MOVIE obtained and finish — never re-search/re-transfer.
  const onDisk = await sandbox.inspectTargetDir();
  if (onDisk.some((file) => file.isVideo)) {
    await sandbox.markObtained({ codes: ["MOVIE"] });
    return {
      text: "fast path 已在库:MOVIE",
      steps: 0,
      coverage: await sandbox.finish(),
      escalated: false,
    };
  }

  // 1. Grade the primed raw-snapshot candidates (code, zero LLM): identity is
  //    title + release year.
  const raw = sandbox.rawSnapshotView();
  if (!raw) {
    return {
      text: "无预搜快照(搜索源未响应)",
      steps: 0,
      coverage: await sandbox.finish(),
      escalated: false,
    };
  }
  if (raw.candidates.length === 0) {
    return concludeUncovered(sandbox, {
      text: "无候选(raw snapshot 为空)",
      steps: 0,
      escalated: false,
      reason: "raw snapshot 为空",
    });
  }

  const grading = gradeCandidates(raw.candidates, {
    title: target.title,
    aliases: target.aliases,
    seasons: [],
    year: target.year,
  });

  // 2. Pick the first candidate: a unique A-grade (title + year match) transfers
  //    blind; otherwise the movie selection arbitrator picks one (escalation #1).
  let escalated = false;
  let current: string | null;
  if (grading.uniqueTopGrade && grading.top) {
    current = grading.top.id;
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
      return concludeUncovered(sandbox, {
        text: `仲裁放弃:${arbitration.reasoning || "无可用候选"}`,
        steps: 0,
        escalated,
        reason: arbitration.reasoning || "无可用候选",
      });
    }
  }

  // 3. Transfer → movie digest → flatten+mark / diagnose, with limited dead-link
  //    retries (same transferUntilLanded ceiling as TV).
  const attempted = new Set<string>();
  while (current !== null && attempted.size < MAX_TRANSFER_ATTEMPTS) {
    attempted.add(current);
    const transfer = await sandbox.transferCandidate({
      snapshotId: raw.snapshotId,
      candidateId: current,
    });

    if (transfer.systemicBlock) {
      return {
        text: `系统阻塞:${transfer.systemicBlock.reason}`,
        steps: attempted.size,
        coverage: await sandbox.finish(),
        escalated,
      };
    }

    // Dead link (nothing landed) → advance to the next candidate.
    if (transfer.staging.length === 0) {
      current = nextCandidate(grading, attempted);
      continue;
    }

    const digest = digestMovieStaging(transfer.staging);

    // Nothing landed as a video (subtitle-only / stray) → clear the residue and
    // advance like a dead link. Without the clear, the stray subtitles/nfo would
    // linger in the movie dir and ride the NEXT candidate's flatten (renamed and
    // kept as if they were this film's).
    if (digest.videos.length === 0) {
      await clearMovieLanding(sandbox);
      current = nextCandidate(grading, attempted);
      continue;
    }

    // One clean film → flatten + mark in code, zero LLM.
    if (digest.passes) {
      try {
        await finalizeMovieLanding({ sandbox, digest });
      } catch (error) {
        await clearMovieLanding(sandbox).catch(() => {});
        return concludeUncovered(sandbox, {
          text: `fast path 归位失败:${error instanceof Error ? error.message : String(error)}`,
          steps: attempted.size,
          escalated,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
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
        return concludeUncovered(sandbox, {
          text: `fast path 归位失败:${error instanceof Error ? error.message : String(error)}`,
          steps: attempted.size,
          escalated,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      return {
        text: `仲裁 accept:${diagnosis.reasoning}`,
        steps: attempted.size,
        coverage: await sandbox.finish(),
        escalated,
      };
    }
    if (diagnosis.action === "abandon") {
      await clearMovieLanding(sandbox);
      return concludeUncovered(sandbox, {
        text: `仲裁 abandon:${diagnosis.reasoning}`,
        steps: attempted.size,
        escalated,
        reason: diagnosis.reasoning,
      });
    }
    // retry_other → clear the bad landing's files and try the next candidate.
    await clearMovieLanding(sandbox);
    current = nextCandidate(grading, attempted);
  }

  // Candidates exhausted or attempt cap hit → clear the leftover landing and
  // report unmet (a wrong film must NOT linger to be mis-read as obtained next
  // patrol).
  await clearMovieLanding(sandbox);
  return {
    text: `fast path 未覆盖(尝试 ${attempted.size} 个候选)`,
    steps: attempted.size,
    coverage: await sandbox.finish(),
    escalated,
  };
}

