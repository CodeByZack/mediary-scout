import type { LanguageModel } from "ai";
import { arbitrateDiagnosis, arbitrateSelection } from "./arbitrator.js";
import { gradeCandidates, summarizeGrading } from "./candidate-grader.js";
import { finalizeLanding } from "./finalize-landing.js";
import { TaskSandbox } from "./sandbox.js";
import { digestStaging } from "./staging-digest.js";
import type { TvAnimeTarget } from "./task-agents.js";

/**
 * The fast path (§6.5): the acquisition happy path runs entirely in CODE, with
 * the LLM demoted from "full-driver 60-step tool loop" to two pure single-call
 * judgments (the arbitrator). Flow:
 *
 *   candidate grading (code) → unique A-grade ? transfer : arbitrateSelection
 *     → transfer (code) → staging digest (code) → passes ? finalize : arbitrateDiagnosis
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

export async function runFastPathAcquisition(options: FastPathOptions): Promise<FastPathResult> {
  const { sandbox, model, target, isChineseNative } = options;
  const seasons = target.seasons;
  const needCodes = target.missingEpisodes;

  // 1. Grade the primed raw-snapshot candidates (code, zero LLM).
  const raw = sandbox.rawSnapshotView();
  if (!raw || raw.candidates.length === 0) {
    return {
      text: "无候选(raw snapshot 为空)",
      steps: 0,
      coverage: await sandbox.finish(),
      escalated: false,
    };
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
      return {
        text: `仲裁放弃:${arbitration.reasoning || "无可用候选"}`,
        steps: 0,
        coverage: await sandbox.finish(),
        escalated,
      };
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
      await finalizeLanding({ sandbox, digest, canonicalTitle: target.title, seasons });
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
      await finalizeLanding({ sandbox, digest, canonicalTitle: target.title, seasons });
      return {
        text: `仲裁 accept:${diagnosis.reasoning}`,
        steps: attempted.size,
        coverage: await sandbox.finish(),
        escalated,
      };
    }
    if (diagnosis.action === "abandon") {
      await sandbox.discardStaging();
      return {
        text: `仲裁 abandon:${diagnosis.reasoning}`,
        steps: attempted.size,
        coverage: await sandbox.finish(),
        escalated,
      };
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
