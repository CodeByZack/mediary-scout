import { episodeCodeFromFileName } from "../../episode-code.js";
import { arbitrateSelection } from "../../acquisition-v2/arbitrator.js";
import { gradeCandidates, summarizeGrading } from "../../acquisition-v2/candidate-grader.js";
import { MAX_DEAD_LINK_RETRIES, MAX_TRANSFER_ATTEMPTS } from "./budgets.js";
import { aliasesFallbackReSearch, closeOutTvLanding } from "./landing.js";
import {
  concludeUncovered,
  emitStep,
  fileBaseName,
  logStorageProvider,
  stepLog,
  type FastPathOptions,
  type FastPathResult,
} from "./steps.js";

// 出口名保留（orchestrator/测试从 fast-path.js 引用）；实现体逐字搬迁。
export type { FastPathOptions, FastPathResult };


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


export async function runFastPathAcquisition(options: FastPathOptions): Promise<FastPathResult> {
  const { sandbox, model, target, isChineseNative, onProgress } = options;
  const seasons = target.seasons;
  logStorageProvider(sandbox, target.title, options.storageProvider);

  // 0. Inspect the landing point FIRST (§6b#8): the DB can lag the disk (a prior
  //    run placed files, or a crash left them mid-flight), so episodes already
  //    sitting in their season dirs are marked obtained and dropped from the need
  //    — never re-searched or re-transferred.
  let needCodes = [...target.missingEpisodes];
  const alreadyPresent = new Set<string>();
  // Every parseable code already sitting in the target dir — not just the missing
  // ones. finalize skips these when organizing a full pack: re-moving them hits
  // the drive's same-name auto-`(1)` duplication (live 2026-08-21 Quark bug:
  // Season 03 held E01-E07, a full-season pack re-landed all 8 → seven `(1)` dups).
  const onDiskCodes = new Set<string>();
  const onDisk = await sandbox.inspectTargetDir();
  for (const file of onDisk) {
    const code = episodeCodeFromFileName(fileBaseName(file.path), seasons);
    if (!code) continue;
    onDiskCodes.add(code);
    if (needCodes.includes(code)) {
      alreadyPresent.add(code);
    }
  }
  if (alreadyPresent.size > 0) {
    needCodes = needCodes.filter((code) => !alreadyPresent.has(code));
  }
  const landingDetail =
    alreadyPresent.size > 0
      ? `已在库 ${alreadyPresent.size} 集(${[...alreadyPresent].join(",")}),仍需 ${needCodes.length} 集`
      : `目标缺集未在库(${needCodes.join(",") || "-"}),开始获取`;
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
    // ★ 落地回合交 landing.ts 的 LandingVerdict 状态机收口（design §5）。
    const closed = await closeOutTvLanding({
      sandbox,
      model,
      target,
      onProgress,
      seasons,
      needCodes,
      onDiskCodes,
      grading,
      tried,
      attempted,
      current,
      escalated,
      deadRetries,
      transfer,
    });
    if (closed.done) {
      return closed.done;
    }
    escalated = closed.escalated;
    deadRetries = closed.deadRetries;
    current = closed.next;
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
