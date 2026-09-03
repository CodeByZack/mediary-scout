import type { LanguageModel } from "ai";
import {
  arbitrateMovieDiagnosis,
  arbitrateMovieSelection,
} from "../../acquisition-v2/arbitrator.js";
import { gradeCandidates, summarizeGrading } from "../../acquisition-v2/candidate-grader.js";
import { finalizeMovieLanding } from "../../acquisition-v2/finalize-landing.js";
import type { AgentToolEvent } from "../../acquisition-v2/activity.js";
import type { TaskSandbox } from "../../acquisition-v2/sandbox.js";
import { digestMovieStaging, fileBaseName, type MovieStagingDigest } from "../../acquisition-v2/staging-digest.js";
import type { MovieTarget } from "../../acquisition-v2/target-types.js";
import { pickSubtitle } from "../../acquisition-v2/subtitle-picker.js";
import type { AssrtProviderPort } from "../../subtitle-provider.js";
import { MAX_DEAD_LINK_RETRIES, MAX_FALLBACK_TRANSFER_ATTEMPTS, MAX_TRANSFER_ATTEMPTS } from "./budgets.js";
import {
  aliasesFallbackReSearch,
  candidateSnapshotId,
  type EvidenceView,
} from "./landing.js";
import {
  concludeUncovered,
  emitStep,
  evidenceDigestLine,
  gradeDistribution,
  logStorageProvider,
  nextCandidate,
  stepLog,
  type TransferStepMeta,
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

/** movie accept 的统一收尾(issue #33 抽离,两个诊断 accept 支共用——代码直收 / AI accept):
 *  字幕落盘(软目标) → finalizeMovieLanding(删附件+flatten+mark) → 归位 step → done。
 *  干净直收(passes)支因结论文案不同(完成:影片已入库 vs 已完成:…(detail))保留原逻辑,
 *  但本 helper 与其使用同一收尾顺序——issue #29 曾两次因复制分支漏 emit 返工,抽出
 *  code/AI 两处共用,减少漂移面。 */
async function finishMovieAccept(options: {
  ctx: MoviePoolContext;
  digest: MovieStagingDigest;
  /** 收尾详情人话(doneDetail 尾部 + done.text)。 */
  detail: string;
  keepVideoId?: string;
  /** 是否已发生 AI 升级(代码直收=false;AI accept=true——由调用方按实际给,不虚增)。 */
  escalated: boolean;
  /** 死链探测次数最新值(循环内 deadRetries += 1 可能已发生,不读 ctx 陈旧值)。 */
  deadRetries: number;
}): Promise<MoviePhaseOutcome> {
  const { ctx, digest, detail, keepVideoId, escalated, deadRetries } = options;
  const { sandbox, target, subtitle, onProgress } = ctx;

  if (subtitle) {
    await landSubtitlesForMovie({
      sandbox,
      title: target.title,
      subtitle,
      ...(onProgress ? { onProgress } : {}),
    });
  }
  try {
    await finalizeMovieLanding({
      sandbox,
      digest,
      ...(keepVideoId !== undefined ? { keepVideoId } : {}),
    });
    // issue #29 九轮拍板:与 TV 一致,不罗列集号;归位 emit 在进 finalize 后必发。
    const organizeDetail = `归位到媒体库:标为已入库`;
    stepLog(sandbox, target.title, "归位", organizeDetail);
    emitStep(onProgress, "finalizeLanding", "organize", organizeDetail, { ok: true });
  } catch (error) {
    await clearMovieLanding(sandbox).catch(() => {});
    const organizeFailDetail = error instanceof Error ? error.message : String(error);
    stepLog(sandbox, target.title, "归位失败", organizeFailDetail, "error");
    emitStep(onProgress, "finalizeLanding", "organize", organizeFailDetail, { ok: false });
    const doneDetail = `失败(归位异常:${error instanceof Error ? error.message : String(error)})`;
    stepLog(sandbox, target.title, "结论", doneDetail);
    emitStep(onProgress, "reportNoCoverage", "finalize", doneDetail);
    return {
      done: await concludeUncovered(sandbox, {
        text: `fast path 归位失败:${error instanceof Error ? error.message : String(error)}`,
        steps: ctx.attempted.size,
        escalated,
        reason: error instanceof Error ? error.message : String(error),
      }),
      escalated,
      deadRetries,
    };
  }
  const doneDetail = `已完成:影片已入库(${detail})`;
  stepLog(sandbox, target.title, "结论", doneDetail);
  emitStep(onProgress, "finish", "finalize", doneDetail);
  return {
    done: {
      text: detail,
      steps: ctx.attempted.size,
      coverage: await sandbox.finish(),
      escalated,
    },
    escalated,
    deadRetries,
  };
}

/** 一个候选池（primary 或兜底）的「选片 + 转存循环」回合(movie 版)。跨池共享
 *  tried / deadRetries / escalated；转存预算按「本池增量」独立计算 —— primary 试穷
 *  不会挤占兜底配额(PR #25)。池内任一步收尾(入库/系统阻塞/归位失败/仲裁终止)即返回 done。 */
interface MoviePoolContext {
  /** issue #29:候选分享链接映射(展示用,不进 LLM prompt)。 */
  urlById?: Record<string, string>;
  sandbox: TaskSandbox;
  model: LanguageModel;
  target: MovieTarget;
  subtitle?: MovieFastPathOptions["subtitle"];
  onProgress?: (event: AgentToolEvent) => void;
  tried: Set<string>;
  attempted: Set<string>;
  deadRetries: number;
  escalated: boolean;
}

interface MoviePhaseOutcome {
  done: MovieFastPathResult | null;
  escalated: boolean;
  deadRetries: number;
}

async function runMovieCandidatePhase(
  ctx: MoviePoolContext,
  view: EvidenceView,
  grading: ReturnType<typeof gradeCandidates>,
  attemptBudget: number,
  poolLabel: string,
): Promise<MoviePhaseOutcome> {
  const { sandbox, model, target, subtitle, onProgress, urlById } = ctx;
  // 本池起点转存数:预算按「本池增量」独立计算(primary 与兜底互不挤占)。
  const poolTransferBase = ctx.attempted.size;
  let escalated = ctx.escalated;
  let deadRetries = ctx.deadRetries;

  // 2. Pick the first candidate: a unique A-grade (title + year match) transfers
  //    blind; otherwise the movie selection arbitrator picks one (escalation #1).
  let current: string | null;
  if (grading.uniqueTopGrade && grading.top) {
    current = grading.top.id;
        // issue #29 用户拍板:选片不显示候选 ID。
    const pickDetail = `选中:《${grading.top.title}》(评级 A,代码直选)`;
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
      const declineDetail = `放弃:${arbitration.reasoning || "没有合适的资源"}`;
      stepLog(sandbox, target.title, "仲裁", declineDetail, "warn");
      const doneDetail = `暂无资源:${arbitration.reasoning || "没有合适的资源"}`;
      stepLog(sandbox, target.title, "结论", doneDetail);
      emitStep(onProgress, "arbitrateSelection", "pick", declineDetail);
      emitStep(onProgress, "reportNoCoverage", "finalize", doneDetail);
      return {
        done: await concludeUncovered(sandbox, {
          text: `暂无资源:${arbitration.reasoning || "没有合适的资源"}`,
          steps: ctx.attempted.size,
          escalated,
          reason: arbitration.reasoning || "无可用候选",
        }),
        escalated,
        deadRetries,
      };
    }
    // Defense-in-depth: the model only sees the graded summary and may return a
    // TITLE or a made-up id instead of a real candidate id. A bogus id must never
    // reach transferCandidate's SANDBOX_CANDIDATE_NOT_IN_SNAPSHOT throw and blow
    // up the whole run — treat it like a declined arbitration (safe uncover).
    if (!view.candidates.some((candidate) => candidate.id === current)) {
      const badIdDetail = `仲裁返回了不存在的候选,按放弃处理`;
      stepLog(sandbox, target.title, "仲裁", badIdDetail, "error");
      const doneDetail = `暂无资源:仲裁结果异常(已按放弃)`;
      stepLog(sandbox, target.title, "结论", doneDetail);
      emitStep(onProgress, "arbitrateSelection", "pick", badIdDetail);
      emitStep(onProgress, "reportNoCoverage", "finalize", doneDetail);
      return {
        done: await concludeUncovered(sandbox, {
          text: `暂无资源:仲裁结果异常(已按放弃)${current ? `(${current})` : ""}`,
          steps: ctx.attempted.size,
          escalated,
          reason: `仲裁返回非法候选 id（不在快照中）:${current}`,
        }),
        escalated,
        deadRetries,
      };
    }
        // issue #29:仲裁选片不显示候选 ID。
    const pickedTitle = grading.ranked.find((c) => c.id === current)?.title ?? "候选";
    const pickedDetail = `选中:《${pickedTitle}》${arbitration.reasoning ? `(${arbitration.reasoning})` : ""}`;
    stepLog(sandbox, target.title, "仲裁", pickedDetail);
    emitStep(onProgress, "arbitrateSelection", "pick", pickedDetail);
  }

  // 3. Transfer → movie digest → flatten+mark / diagnose, with limited dead-link
  //    retries (same transferUntilLanded ceiling as TV). A dead link (nothing
  //    landed) is a CHEAP fail-loud probe — counted separately, NOT as a transfer
  //    attempt; only a real materialized transfer (attempted) counts toward THIS
  //    pool's budget.
  while (
    current !== null &&
    ctx.attempted.size - poolTransferBase < attemptBudget &&
    deadRetries < MAX_DEAD_LINK_RETRIES
  ) {
    ctx.tried.add(current);
        // issue #29:转存动作人话 + 不显示候选 ID;链接进 args.linkUrl(前端可点)。
    const currentTitle = grading.ranked.find((c) => c.id === current)?.title ?? "";
    const transferDetail = `转存《${currentTitle || "候选"}》到暂存区(第 ${ctx.attempted.size - poolTransferBase + 1} 次转存)`;
    stepLog(sandbox, target.title, "转存", transferDetail);
    // issue #29:转存步骤的结构化证据(卡片化,与 tv.ts 对齐)。round 跨池单调递增,
    // 给前端「第几轮转存」;movie 补上后活动页记录也按轮次卡片渲染。
    const transferMeta: TransferStepMeta = {
      round: ctx.attempted.size + 1,
      pool: poolLabel === "兜底" ? "fallback" : "primary",
      decidedBy: grading.uniqueTopGrade ? "code" : "ai",
      transferIndex: ctx.attempted.size - poolTransferBase + 1,
    };
    emitStep(onProgress, "transferCandidate", "transfer", transferDetail, { candidateId: current, ...(currentTitle ? { title: currentTitle } : {}), ...transferMeta, ...(urlById?.[current] !== undefined ? { linkUrl: urlById[current] } : {}) });
    const transfer = await sandbox.transferCandidate({
      snapshotId: candidateSnapshotId(view, current),
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
        done: {
          text: `系统阻塞:${transfer.systemicBlock.reason}`,
          steps: ctx.attempted.size,
          coverage: await sandbox.finish(),
          escalated,
        },
        escalated,
        deadRetries,
      };
    }

    // Dead link (nothing landed) → a cheap probe, not a transfer attempt; advance
    // to the next candidate until the dead-link scan cap or the pool is exhausted.
    if (transfer.staging.length === 0) {
      deadRetries += 1;
      const next = nextCandidate(grading, ctx.tried);
          // issue #29:死链不显示候选 ID。
    const deadTitle = grading.ranked.find((c) => c.id === current)?.title ?? "该候选";
    const deadDetail = `《${deadTitle}》死链(转存未落盘)${next ? `,重试换一条候选(${deadRetries}/${MAX_DEAD_LINK_RETRIES})` : ",没有可换的"}`;
      stepLog(sandbox, target.title, "转存失败", deadDetail, "warn");
      emitStep(onProgress, "transferCandidate", "transfer", deadDetail, { candidateId: current });
      current = next;
      continue;
    }

    // A real transfer happened — this is the countable attempt.
    ctx.attempted.add(current);
    const digest = digestMovieStaging(transfer.staging);

    // Nothing landed as a video (subtitle-only / stray) → clear the residue and
    // advance like a dead link. Without the clear, the stray subtitles/nfo would
    // linger in the movie dir and ride the NEXT candidate's flatten (renamed and
    // kept as if they were this film's).
    if (digest.videos.length === 0) {
      await clearMovieLanding(sandbox);
      const next = nextCandidate(grading, ctx.tried);
      const noVideoDetail = `没有落盘任何视频(仅字幕/杂项),清空后换一条候选${next ? "" : "(没有可换的,终止)"}`;
      stepLog(sandbox, target.title, "digest 验证", noVideoDetail, "warn");
      emitStep(onProgress, "stagingDigest", "verify", noVideoDetail);
      current = next;
      continue;
    }

    // issue #29 用户拍板:activity 人话化——但 movie 的 digest.summary 同时是诊断仲裁 LLM 输入,
    // 保持富信息(文件名单/脏包信号);UI 用 digestDetail 人话结论。
    // issue #33:三支——干净直收(1 部正片) / 代码直收(多视频但正片明显占优) / 交诊断仲裁。
    let digestDetail: string;
    if (digest.passes) {
      digestDetail = `一部正片(视频 ${digest.videos.length} / 字幕 ${digest.subtitles.length})`;
    } else if (digest.dominant !== null) {
      digestDetail = `多视频但正片明显占优:保留 ${digest.dominant.keptName},丢弃 ${digest.dominant.dropped.map((d) => d.name).join(" / ") || "(无)"},代码直收`;
    } else if (digest.isDirtyPack) {
      digestDetail = `不是单部正片(${digest.videos.length} 个视频文件${digest.junkSignals.length > 0 ? ",含广告/花絮等多余文件" : ""}),交给诊断仲裁`;
    } else {
      digestDetail = "没有落盘任何视频,换一条候选";
    }
    stepLog(
      sandbox,
      target.title,
      "digest 验证",
      digestDetail,
      digest.passes || digest.dominant !== null ? "log" : "warn",
    );
    // issue #29:digest 步骤结构化证据(卡片化判定)。round 与转存轮次一致,
    // 前端把 digest 并入该轮转存卡(passes/videoCount 供判定与「N 个文件」展示)。
    emitStep(onProgress, "stagingDigest", "verify", digestDetail, {
      passes: digest.passes,
      videoCount: digest.videos.length,
      round: ctx.attempted.size,
    });

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
        await finalizeMovieLanding({ sandbox, digest });
        // issue #29 九轮拍板:与 TV 一致,不罗列集号(明细在 rename 列表里)。
        // 九轮复核:movie.length 是 flatten 后目录清单(含零移动/字幕),不实——去掉计数。
        const organizeDetail = `归位到媒体库:标为已入库`;
        stepLog(sandbox, target.title, "归位", organizeDetail);
        emitStep(onProgress, "finalizeLanding", "organize", organizeDetail, { ok: true });
      } catch (error) {
        await clearMovieLanding(sandbox).catch(() => {});
        const organizeFailDetail = error instanceof Error ? error.message : String(error);
        stepLog(sandbox, target.title, "归位失败", organizeFailDetail, "error");
        emitStep(onProgress, "finalizeLanding", "organize", organizeFailDetail, { ok: false });
        const doneDetail = `失败(归位异常:${error instanceof Error ? error.message : String(error)})`;
        stepLog(sandbox, target.title, "结论", doneDetail);
        emitStep(onProgress, "reportNoCoverage", "finalize", doneDetail);
        return {
          done: await concludeUncovered(sandbox, {
            text: `fast path 归位失败:${error instanceof Error ? error.message : String(error)}`,
            steps: ctx.attempted.size,
            escalated,
            reason: error instanceof Error ? error.message : String(error),
          }),
          escalated,
          deadRetries,
        };
      }
      const doneDetail = "完成:影片已入库";
      stepLog(sandbox, target.title, "结论", doneDetail);
      emitStep(onProgress, "finish", "finalize", doneDetail);
      return {
        done: {
          text: "影片已入库",
          steps: ctx.attempted.size,
          coverage: await sandbox.finish(),
          escalated,
        },
        escalated,
        deadRetries,
      };
    }

    // Not one clean film → try code-based dominant-video acceptance first
    // (issue #33:多视频但最大视频明显占优+其余为花絮/trailer等 → 零 LLM 直收),
    // fall back to diagnostic arbitration (escalation #2).
    if (digest.dominant !== null) {
      // 代码直收:zero LLM——不新增 AI 升级,但也绝不抹掉前面选片仲裁已置的 escalated
      // (fast-path.test.ts:145 交叉格契约)。日志:判据数字 + 被删名单+体积,出错可回溯(#33)。
      const droppedList = digest.dominant.dropped
        .map((d) => `${d.name}(${(d.bytes / (1024 * 1024)).toFixed(0)}MB)`)
        .join(", ");
      const codeAcceptDetail =
        `正片清晰:保留 ${digest.dominant.keptName} (${(digest.dominant.keptBytes / (1024 * 1024)).toFixed(0)}MB),` +
        `丢弃 ${droppedList || "(无)"}(判据 主片>其余和×${digest.dominant.ratio} 且附件≤${digest.dominant.junkMaxBytes / (1024 * 1024)}MB)`;
      stepLog(sandbox, target.title, "诊断", codeAcceptDetail, "log");
      emitStep(onProgress, "arbitrateDiagnosis", "verify", codeAcceptDetail, {
        aiUsed: false,
        dominant: {
          kept: digest.dominant.keptName,
          dropped: digest.dominant.dropped.map((d) => d.name),
        },
      });
      return finishMovieAccept({
        ctx,
        digest,
        detail: codeAcceptDetail,
        keepVideoId: digest.dominant.id,
        escalated, // 当前局部值:code 直收不新增升级,存在则保留
        deadRetries, // 循环内死链探针可能已累加,带出最新值
      });
    }
    // 代码判不了 → 诊断仲裁(AI)。
    escalated = true;
    const diagnosis = await arbitrateMovieDiagnosis({
      model,
      summary: digest.summary,
      title: target.title,
      year: target.year,
    });
    if (diagnosis.action === "accept") {
      // issue #33 映射日志:AI 支把输入名单(喂给 AI 的 digest.summary 含全量文件)一起
      // 写进日志,再走统一收尾;emit 在归位之前,时序与 code 支一致。
      const aiDetail = `诊断仲裁(${digest.videos.length} 个视频:${digest.videos.map((v) => fileBaseName(v)).join(" / ")}): ${diagnosis.reasoning || "正片可收"}`;
      stepLog(sandbox, target.title, "诊断", aiDetail, "log");
      // 注意:不传 aiUsed:true——step-args-text.ts:91 会把它渲染成「AI 已介入集数映射」,
      // 那是 TV 集数映射专用文案,movie 没有集数映射,挂上去是错误文案。🤖 徽章由
      // arbitrate* 前缀提供(activity-feed.tsx stepUsedAI),无需显式 true。
      emitStep(onProgress, "arbitrateDiagnosis", "verify", aiDetail, {
        reasoning: diagnosis.reasoning,
      });
      return finishMovieAccept({
        ctx,
        digest,
        detail: aiDetail,
        escalated,
        deadRetries,
      });
    }
    if (diagnosis.action === "abandon") {
      await clearMovieLanding(sandbox);
      const declineDetail = `放弃:${diagnosis.reasoning}`;
      stepLog(sandbox, target.title, "仲裁", declineDetail, "warn");
      const doneDetail = `放弃:${diagnosis.reasoning}`;
      stepLog(sandbox, target.title, "结论", doneDetail);
      emitStep(onProgress, "arbitrateDiagnosis", "pick", declineDetail);
      emitStep(onProgress, "reportNoCoverage", "finalize", doneDetail);
      return {
        done: await concludeUncovered(sandbox, {
          text: `放弃:${diagnosis.reasoning}`,
          steps: ctx.attempted.size,
          escalated,
          reason: diagnosis.reasoning,
        }),
        escalated,
        deadRetries,
      };
    }
    // retry_other → clear the bad landing's files and try the next candidate.
    await clearMovieLanding(sandbox);
    const next = nextCandidate(grading, ctx.tried);
    const retryDetail = `这轮内容不对:清掉暂存换一条候选${next ? "" : "(没有可换的,终止)"}`;
    stepLog(sandbox, target.title, "仲裁", retryDetail, "warn");
    emitStep(onProgress, "arbitrateDiagnosis", "pick", retryDetail);
    current = next;
  }
  return { done: null, escalated, deadRetries };
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
    emitStep(onProgress, "inspectTargetDir", "search", "影片已在媒体库(无需重转)");
    await sandbox.markObtained({ codes: ["MOVIE"] });
    emitStep(onProgress, "markObtained", "mark", "影片已入库", { codes: ["MOVIE"] });
    const doneDetail = "完成:影片已在媒体库";
    stepLog(sandbox, target.title, "落点检查", "影片已在媒体库(无需重转)");
    stepLog(sandbox, target.title, "结论", doneDetail);
    emitStep(onProgress, "finish", "finalize", doneDetail);
    return {
      text: "影片已在媒体库",
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
  // issue #29:候选分享链接全链透出(展示用,不进 LLM);键=完整候选 id。
  const mtUrlById: Record<string, string> = {};
  for (const c of raw?.candidates ?? []) {
    if (c.url) mtUrlById[c.id] = c.url;
  }
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

  // 共享记账:跨池共享 tried / deadRetries / escalated;attempted 是「当前做转存的池」的真实
  // 转存集合(阶段1 primary 用 MAX_TRANSFER_ATTEMPTS;阶段2 兜底用 MAX_FALLBACK_TRANSFER_ATTEMPTS),
  // 两阶段各按自己的预算跑循环,互不挤占 —— primary 试穷不会让兜底无配额可转。
  const tried = new Set<string>();
  const attempted = new Set<string>();
  let deadRetries = 0;
  let escalated = false;
  let fallbackRounds = 0;

  const gradeCounts = { A: 0, B: 0, C: 0, D: 0 };
  for (const candidate of grading.ranked) gradeCounts[candidate.grade] += 1;
  const primaryHasA = gradeCounts.A > 0;

  stepLog(
    sandbox,
    target.title,
    "评分决策",
    `${gradeDistribution(grading)} → ${
      grading.uniqueTopGrade
        ? "唯一 A,primary 池盲转"
        : primaryHasA
          ? `有 A 但非唯一(${gradeCounts.A} 个),primary 池优先仲裁;转存不足才走别名兜底`
          : target.aliases.length > 0
            ? "无 A 候选,直接转入别名兜底(预算 ≤3 轮)"
            : "无 A 且无别名,直接进入选片"
    }`,
  );
  if (grading.ranked.length > 0) {
    stepLog(sandbox, target.title, "评分摘要", evidenceDigestLine(grading));
  }

  // primary 空且无别名:无任何证据可转 → 零 LLM 诚实终止(旧行为;空池但有别名时,
  // 阶段2 的 aliasesFallbackReSearch 会去兜底「搜得到」的新证据,不在此处终止)。
  if (grading.ranked.length === 0 && target.aliases.length === 0) {
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

  // primary 池评分步骤(池非空才 emit;空池有别名时由阶段2 的评分步骤接管,序列不重复)。
  if (grading.ranked.length > 0) {
    const gradingDetail = `(年份判据 ${target.year ?? "未知"}) A ${gradeCounts.A} / B ${gradeCounts.B} / C ${gradeCounts.C} / D ${gradeCounts.D}`;
    stepLog(sandbox, target.title, "评分", gradingDetail);
    stepLog(sandbox, target.title, "评分摘要", evidenceDigestLine(grading));
    emitStep(onProgress, "gradeCandidates", "search", gradingDetail);
  }

  // ★ 阶段1 —— primary 池:只要 primary 有 A 候选(或根本没有别名可兜底)就先转存 primary,
  //    绝不在有 A 时提前跳兜底(PR #25:反「primary 候选却被兜底池替换」)。
  if (primaryHasA || target.aliases.length === 0) {
    const primaryOutcome = await runMovieCandidatePhase(
      {
        sandbox,
        model,
        target,
        ...(subtitle !== undefined ? { subtitle } : {}),
        ...(onProgress !== undefined ? { onProgress } : {}),
        tried,
        attempted,
        deadRetries,
        escalated,
        urlById: mtUrlById,
      },
      raw,
      grading,
      MAX_TRANSFER_ATTEMPTS,
      "primary",
    );
    escalated = primaryOutcome.escalated;
    deadRetries = primaryOutcome.deadRetries;
    if (primaryOutcome.done) return primaryOutcome.done;
  }

  // ★ 阶段2 —— 兜底池:仅当 primary 无 A 候选、或 primary 转存预算耗尽仍未覆盖时启动。
  //    独立的转存预算(MAX_FALLBACK_TRANSFER_ATTEMPTS),primary 试穷不影响兜底配额。
  if (target.aliases.length > 0) {
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
    fallbackRounds = fallback.rounds;
    const fallbackView = fallback.view;
    // issue #29 用户拍板 + 复核:movie 兜底池合并 primary 表,补 fallbackView 新候选链接(照 TV fbUrlById)。
    const mbUrlById: Record<string, string> = { ...mtUrlById };
    for (const c of fallbackView.candidates) {
      if (c.url) mbUrlById[c.id] = c.url;
    }
    grading = fallback.grading;
    if (fallback.restored) {
      stepLog(
        sandbox,
        target.title,
        "证据恢复",
        `合并 primary+兜底 证据池 ${fallbackView.candidates.length} 条候选(兜底共搜 ${fallback.rounds} 轮,零额外 PanSou 请求)交 AI 选择`,
      );
    }
    if (fallbackView.candidates.length === 0) {
      const doneDetail = "暂无资源(快照为空)";
      stepLog(sandbox, target.title, "结论", doneDetail);
      emitStep(onProgress, "reportNoCoverage", "finalize", doneDetail);
      return concludeUncovered(sandbox, {
        text: "无候选(raw snapshot 为空)",
        steps: attempted.size,
        escalated,
        reason: "raw snapshot 为空",
      });
    }
    const fbCounts = { A: 0, B: 0, C: 0, D: 0 };
    for (const candidate of grading.ranked) fbCounts[candidate.grade] += 1;
    // issue #29 用户实测 + 复核:文案按 fallback.restored 分支——兜底命中唯一 A 提前停时
    // 既没耗尽也没合并更没 AI 选(零 LLM 直转),不能无条件写「AI 选择」(与「代码直选」同屏打脸)。
    const fbDetail = fallback.restored
      ? grading.uniqueTopGrade
        ? `兜底耗尽,合并证据池 ${fallbackView.candidates.length} 条候选,唯一 A 直接转存(A ${fbCounts.A} / B ${fbCounts.B} / C ${fbCounts.C} / D ${fbCounts.D})`
        : `兜底耗尽,合并证据池 ${fallbackView.candidates.length} 条候选,AI 选择(A ${fbCounts.A} / B ${fbCounts.B} / C ${fbCounts.C} / D ${fbCounts.D})`
      : `兜底第 ${fallback.rounds} 轮命中唯一 A,直接转存(A ${fbCounts.A} / B ${fbCounts.B} / C ${fbCounts.C} / D ${fbCounts.D})`;
    stepLog(sandbox, target.title, "评分", fbDetail);
    stepLog(sandbox, target.title, "评分摘要", evidenceDigestLine(grading));
    emitStep(onProgress, "gradeCandidates", "search", fbDetail);

    const fallbackOutcome = await runMovieCandidatePhase(
      {
        sandbox,
        model,
        target,
        ...(subtitle !== undefined ? { subtitle } : {}),
        ...(onProgress !== undefined ? { onProgress } : {}),
        tried,
        attempted,
        deadRetries,
        escalated,
        urlById: mbUrlById,
      },
      fallbackView,
      grading,
      MAX_FALLBACK_TRANSFER_ATTEMPTS,
      "兜底",
    );
    escalated = fallbackOutcome.escalated;
    deadRetries = fallbackOutcome.deadRetries;
    if (fallbackOutcome.done) return fallbackOutcome.done;
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
