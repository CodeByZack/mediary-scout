import { episodeCodeFromFileName, episodeDateConflict } from "../../episode-code.js";
import { arbitrateSelection } from "../../acquisition-v2/arbitrator.js";
import { gradeCandidates, summarizeGrading } from "../../acquisition-v2/candidate-grader.js";
import {
  MAX_DEAD_LINK_RETRIES,
  MAX_FALLBACK_TRANSFER_ATTEMPTS,
  MAX_TRANSFER_ATTEMPTS,
} from "./budgets.js";
import {
  aliasesFallbackReSearch,
  candidateSnapshotId,
  closeOutTvLanding,
  type EvidenceView,
} from "./landing.js";
import {
  concludeUncovered,
  emitStep,
  fileBaseName,
  evidenceDigestLine,
  gradeDistribution,
  gradedCandidateEvidence,
  logStorageProvider,
  stepLog,
  type FastPathOptions,
  type FastPathResult,
  type TransferStepMeta,
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
 *
 * Two-stage candidate pools (PR #25): the PRIMARY pool (searched by title) is
 * always tried FIRST — a unique A transfers blind, multiple A's go to the
 * selection arbitrator. The aliases 兜底 pool only runs when the primary pool
 * has NO A-grade at all, or the primary pool's transfer budget is exhausted
 * without coverage. The two pools carry INDEPENDENT transfer budgets
 * (MAX_TRANSFER_ATTEMPTS / MAX_FALLBACK_TRANSFER_ATTEMPTS), so a primary pool
 * full of off-target packs can never starve the aliases' hits.
 */

/** 一个候选池（primary 或兜底）的「选片 + 转存循环」回合。跨池共享 tried / deadRetries /
 *  escalated；转存预算(attempted)按池独立记账 —— closeOutTvLanding 用哪个 set 就往哪个
 *  set 加,循环上限(attemptBudget)由调用方传池自身的预算。 */
interface TvPoolContext {
  sandbox: FastPathOptions["sandbox"];
  model: FastPathOptions["model"];
  target: FastPathOptions["target"];
  onProgress: FastPathOptions["onProgress"];
  seasons: number[];
  needCodes: string[];
  onDiskCodes: Set<string>;
  tried: Set<string>;
  attempted: Set<string>;
  deadRetries: number;
  escalated: boolean;
  /** TMDB 各集播出日(SxxExx→"YYYY-MM-DD",可缺省)—— digest/finalize 共用的年守卫数据。 */
  episodeAirDates?: Record<string, string>;
  /** issue #29:候选 id→分享链接映射(用户拍板透出到活动页)。 */
  urlById?: Record<string, string>;
  /** TMDB 各集原始 name(SxxExx→"Episode 10 (Part 1)")—— 综艺「第N期」Part 锚定。 */
  episodeNames?: Record<string, string>;
}

/** 阶段运行结果。done 非空 = 该池已收尾(入库或诚实终止)，直接返回；否则 caller 决定是否
 *  进下一池。 */
interface TvPhaseOutcome {
  done: FastPathResult | null;
  escalated: boolean;
  deadRetries: number;
}

async function runTvCandidatePhase(
  ctx: TvPoolContext,
  view: EvidenceView,
  grading: ReturnType<typeof gradeCandidates>,
  attemptBudget: number,
  poolLabel: string,
): Promise<TvPhaseOutcome> {
  const { sandbox, model, target, onProgress, seasons, needCodes, onDiskCodes, urlById } = ctx;
  // 本池起点转存数:预算按「本池增量」独立计算(primary 与兜底互不挤占)。
  const poolTransferBase = ctx.attempted.size;
  // 2. Pick the first candidate: a unique A-grade transfers blind; otherwise the
  //    selection arbitrator picks one (escalation #1).
  let escalated = ctx.escalated;
  let deadRetries = ctx.deadRetries;
  let current: string | null;
  if (grading.uniqueTopGrade && grading.top) {
    current = grading.top.id;
    // issue #29 用户反馈:不显示候选 ID,只留标题;动作人话化(唯一 A 级,代码直选)。
    const pickDetail = `选中:《${grading.top.title}》(评级 A,代码直选)`;
    stepLog(sandbox, target.title, "选片", pickDetail);
    // issue #29:盲转=代码决策(code);供前端标记「谁选的」。
    emitStep(onProgress, "pickCandidate", "pick", pickDetail, {
      candidateId: current,
      title: grading.top.title,
      decidedBy: "code",
      ...(ctx.urlById?.[current] !== undefined ? { linkUrl: ctx.urlById[current] } : {}),
    });
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
      const declineDetail = `放弃:${arbitration.reasoning || "没有合适的资源"}`;
      stepLog(sandbox, target.title, "仲裁", declineDetail, "warn");
      const doneDetail = `暂无资源:${arbitration.reasoning || "没有合适的资源"}`;
      stepLog(sandbox, target.title, "结论", doneDetail);
      emitStep(onProgress, "arbitrateSelection", "pick", declineDetail, {
        // issue #29 用户拍板:候选列表只在 gradeCandidates 展示一次,仲裁结果不带全表。
        reasoning: arbitration.reasoning ?? null,
        selected: null,
      });
      // 结账行由主流程 done 分支统一 emit(此处不再重复;旧代码此路径单条结账,P1-2 修复)。
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
      // issue #29 用户拍板:UI 不显示候选 ID(aI 幻觉防御分支也不露)。排障 ID 留在 reason 字段。
      const badIdDetail = `仲裁返回了不存在的候选,按放弃处理`;
      stepLog(sandbox, target.title, "仲裁", badIdDetail, "error");
      const doneDetail = `暂无资源:仲裁结果异常(已按放弃)${current ? `(${current})` : ""}`;
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
        // issue #29:Ai 仲裁选片:不显示候选 ID;标题从当前评级找(找不到退「候选」)。
    const pickedTitle = grading.ranked.find((c) => c.id === current)?.title ?? "候选";
    const pickedDetail = `选中:《${pickedTitle}》${arbitration.reasoning ? `(${arbitration.reasoning})` : ""}`;
    stepLog(sandbox, target.title, "仲裁", pickedDetail);
    emitStep(onProgress, "arbitrateSelection", "pick", pickedDetail, {
      // issue #29:仲裁结果不带候选全表(gradeCandidates 已展示);只带结论与 AI 决策标记。
      reasoning: arbitration.reasoning ?? null,
      selected: current,
      // issue #29:仲裁选片=AI 决策(ai),供前端标记「谁选的」。
      decidedBy: "ai",
    });
  }

  // 3. Transfer → digest → finalize / diagnose, with limited retries for dead
  //    links and off-target packs. A dead link (nothing landed) is a CHEAP
  //    fail-loud probe — it must NOT consume the transfer-attempt budget, so it
  //    is counted separately (MAX_DEAD_LINK_RETRIES) and only a real materialized
  //    transfer (attempted) counts toward THIS pool's budget.
  while (
    current !== null &&
    ctx.attempted.size - poolTransferBase < attemptBudget &&
    deadRetries < MAX_DEAD_LINK_RETRIES
  ) {
    ctx.tried.add(current);
    // issue #29 用户反馈:转存文案人话化——动作(转存到暂存区)+ 第几次,不显示候选 ID;
    // 链接在 args.linkUrl(前端展示可点),标题在 args.title。
    const currentTitle = grading.ranked.find((c) => c.id === current)?.title ?? "";
    const transferDetail = `转存《${currentTitle || "候选"}》到暂存区(${ctx.attempted.size - poolTransferBase + 1}/${attemptBudget} 次转存)`;
    stepLog(sandbox, target.title, "转存", transferDetail);
    // issue #29:转存步骤的结构化证据(卡片化)。round 跨池单调递增,给前端「第几轮转存」。
    const transferMeta: TransferStepMeta = {
      round: ctx.attempted.size + 1,
      pool: poolLabel === "兜底" ? "fallback" : "primary",
      decidedBy: grading.uniqueTopGrade ? "code" : "ai",
      transferIndex: ctx.attempted.size - poolTransferBase + 1,
    };
    // issue #29:转存步骤带标题+链接(用户拍板展示;标题来自当前分级候选,链接来自 urlById)。
    emitStep(onProgress, "transferCandidate", "transfer", transferDetail, { candidateId: current, ...(currentTitle ? { title: currentTitle } : {}), ...transferMeta, ...(ctx.urlById?.[current] !== undefined ? { linkUrl: ctx.urlById[current] } : {}) });
    const transfer = await sandbox.transferCandidate({
      snapshotId: candidateSnapshotId(view, current),
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
      tried: ctx.tried,
      attempted: ctx.attempted,
      current,
      escalated,
      deadRetries,
      transfer,
      ...(ctx.episodeAirDates !== undefined ? { episodeAirDates: ctx.episodeAirDates } : {}),
      ...(ctx.episodeNames !== undefined ? { episodeNames: ctx.episodeNames } : {}),
    });
    if (closed.done) {
      return { done: closed.done, escalated: closed.escalated, deadRetries: closed.deadRetries };
    }
    escalated = closed.escalated;
    deadRetries = closed.deadRetries;
    current = closed.next;
  }
  return { done: null, escalated, deadRetries };
}

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
    const base = fileBaseName(file.path);
    const code = episodeCodeFromFileName(base, seasons);
    if (!code) continue;
    // 年守卫同样作用于在库文件:名字像 E11 但自带日期与播出日矛盾的,不据此
    // 反标 obtained(防历史错标件把缺集"自我认证"掉)。
    if (episodeDateConflict(code, base, target.episodeAirDates)) continue;
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
  let raw: EvidenceView | null = sandbox.rawSnapshotView();
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
  emitStep(onProgress, "viewResourceSnapshot", "search", snapshotDetail, {
    // issue #29 用户拍板:候选列表只在评分步骤展示一次,预搜快照只报数量。
  });

  // issue #29 用户拍板:链接透出到活动页(全部候选可点)。评分后的 GradedCandidate 不带
  // providerPayload,这里在评分前从 raw(带 url)另建 id→url 映射,供评级列表/pick/转存注入链接。
  const urlById: Record<string, string> = {};
  for (const c of raw.candidates) {
    if (c.url) urlById[c.id] = c.url;
  }

  let grading = gradeCandidates(raw.candidates, {
    title: target.title,
    aliases: target.aliases,
    seasons,
    isChineseNative,
  });

  // 共享记账：跨池共享 tried / deadRetries / escalated；attempted 是「当前做转存的池」的
  // 真实转存集合(阶段1 primary 用 MAX_TRANSFER_ATTEMPTS;阶段2 兜底用 MAX_FALLBACK_TRANSFER_ATTEMPTS)。
  // 两阶段各按自己的预算跑循环,互不挤占 —— primary 试穷不会让兜底无配额可转。
  const tried = new Set<string>();
  const attempted = new Set<string>();
  let deadRetries = 0;
  let escalated = false;
  let fallbackRounds = 0;

  // primary 池真实转存数(阶段1 结束时的 attempted.size);阶段2 结账行用它做差。
  let primaryTransfers = 0;

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
  emitStep(
    onProgress,
    "gradingDecision",
    "search",
    `uniqueA=${grading.uniqueTopGrade ? "yes" : "no"} A=${gradeCounts.A}(${gradeDistribution(grading)})`,
    // issue #29 用户拍板:候选列表只在 gradeCandidates 步骤展示一次,决策摘要不再带列表。
    { uniqueTopGrade: grading.uniqueTopGrade },
  );

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
    const primaryGradingDetail = `A ${gradeCounts.A} / B ${gradeCounts.B} / C ${gradeCounts.C} / D ${gradeCounts.D}`;
    stepLog(sandbox, target.title, "评分", primaryGradingDetail);
    stepLog(sandbox, target.title, "评分摘要", evidenceDigestLine(grading));
    emitStep(onProgress, "gradeCandidates", "search", primaryGradingDetail, {
      candidates: gradedCandidateEvidence(grading, urlById),
      uniqueTopGrade: grading.uniqueTopGrade,
      fallbackRounds,
    });
  }

  const ctx: TvPoolContext = {
    sandbox,
    model,
    target,
    onProgress,
    seasons,
    needCodes,
    onDiskCodes,
    tried,
    attempted,
    deadRetries,
    escalated,
    ...(target.episodeAirDates !== undefined ? { episodeAirDates: target.episodeAirDates } : {}),
    ...(target.episodeNames !== undefined ? { episodeNames: target.episodeNames } : {}),
  };

  // ★ 阶段1 —— primary 池:只要 primary 有 A 候选(或根本没有别名可兜底)就先转存 primary,
  //    绝不在有 A 时提前跳兜底(PR #25:反「primary 14 个 A 却被兜底池替换」)。
  if (primaryHasA || target.aliases.length === 0) {
    const primaryOutcome = await runTvCandidatePhase(
      { ...ctx, urlById },
      raw,
      grading,
      MAX_TRANSFER_ATTEMPTS,
      "primary",
    );
    escalated = primaryOutcome.escalated;
    deadRetries = primaryOutcome.deadRetries;
    if (primaryOutcome.done) {
      // issue #29 用户反馈:结账行人话——activity 只讲结果,统计细节放 args(前端展示)。
      const primaryDoneDetail = `转存 ${ctx.attempted.size} 次完成${escalated ? ",AI 介入" : ""}`;
      stepLog(sandbox, target.title, "结账", primaryDoneDetail);
      emitStep(onProgress, "runCheckout", "finalize", primaryDoneDetail, {
        transfers: ctx.attempted.size,
        fallbackTransfers: 0,
        deadLinkRetries: deadRetries,
        searches: 1 + fallbackRounds,
        aiEscalated: escalated,
      });
      return primaryOutcome.done;
    }
    primaryTransfers = ctx.attempted.size;
    // primary 池试尽仍未覆盖 → 落到兜底池(若有别名)。
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
          seasons,
          isChineseNative,
        }),
    });
    fallbackRounds = fallback.rounds;
    const fallbackView = fallback.view;
    grading = fallback.grading;
    // issue #29:兜底合并证据池同样透传链接(候选带 url,fallbackView 与 raw 同形状)。
    const fbUrlById: Record<string, string> = {};
    for (const c of fallbackView.candidates) {
      if (c.url) fbUrlById[c.id] = c.url;
    }
    if (fallback.restored) {
      stepLog(
        sandbox,
        target.title,
        "证据恢复",
        `合并 primary+兜底 证据池 ${fallbackView.candidates.length} 条候选(兜底共搜 ${fallback.rounds} 轮,零额外 PanSou 请求)继续仲裁`,
      );
    }

    if (fallbackView.candidates.length === 0) {
      const doneDetail = "暂无资源(快照为空)";
      stepLog(sandbox, target.title, "结论", doneDetail);
      emitStep(onProgress, "reportNoCoverage", "finalize", doneDetail);
      // issue #29 用户反馈:结账行不解释内部配额,一句话人话 + 统计进 args。
      const exhaustedCheckout0 = `转存 ${ctx.attempted.size} 次后仍未拿到目标集${escalated ? "(AI 介入)" : ""}`;
      stepLog(sandbox, target.title, "结账", exhaustedCheckout0);
      emitStep(onProgress, "runCheckout", "finalize", exhaustedCheckout0, {
        transfers: ctx.attempted.size,
        fallbackTransfers: ctx.attempted.size - primaryTransfers,
        deadLinkRetries: deadRetries,
        searches: 1 + fallbackRounds,
        aiEscalated: escalated,
      });
      return concludeUncovered(sandbox, {
        text: "无候选(raw snapshot 为空)",
        steps: ctx.attempted.size,
        escalated,
        reason: "raw snapshot 为空",
      });
    }

    const fbCounts = { A: 0, B: 0, C: 0, D: 0 };
    for (const candidate of grading.ranked) fbCounts[candidate.grade] += 1;
    const fbDetail = `兜底池 A ${fbCounts.A} / B ${fbCounts.B} / C ${fbCounts.C} / D ${fbCounts.D}`;
    stepLog(sandbox, target.title, "评分", fbDetail);
    stepLog(sandbox, target.title, "评分摘要", evidenceDigestLine(grading));
    emitStep(onProgress, "gradeCandidates", "search", fbDetail, {
      candidates: gradedCandidateEvidence(grading, fbUrlById),
      uniqueTopGrade: grading.uniqueTopGrade,
      fallbackRounds,
    });

    const fallbackOutcome = await runTvCandidatePhase(
      { ...ctx, deadRetries, escalated, urlById: fbUrlById },
      fallbackView,
      grading,
      MAX_FALLBACK_TRANSFER_ATTEMPTS,
      "兜底",
    );
    escalated = fallbackOutcome.escalated;
    deadRetries = fallbackOutcome.deadRetries;
    if (fallbackOutcome.done) {
      // issue #29:fallback 完成结账同样人话化(与 primary/耗尽路径一致),统计进 args。
      const fallbackDoneDetail = `转存 ${ctx.attempted.size} 次完成(含兜底)${escalated ? ",AI 介入" : ""}`;
      stepLog(sandbox, target.title, "结账", fallbackDoneDetail);
      emitStep(onProgress, "runCheckout", "finalize", fallbackDoneDetail, {
        transfers: ctx.attempted.size,
        fallbackTransfers: ctx.attempted.size - primaryTransfers,
        deadLinkRetries: deadRetries,
        searches: 1 + fallbackRounds,
        aiEscalated: escalated,
      });
      return fallbackOutcome.done;
    }
  }

  // Candidates exhausted or attempt cap hit → wipe staging and report unmet.
  if ((await sandbox.inspectStaging()).length > 0) {
    await sandbox.discardStaging();
  }
  const exhaustedDetail = `缺集(尝试 ${ctx.attempted.size} 次转存,扫过 ${tried.size} 个候选仍未覆盖)`;
  stepLog(sandbox, target.title, "结论", exhaustedDetail);
  emitStep(onProgress, "reportNoCoverage", "finalize", exhaustedDetail);
  // issue #29:同上人话结账。
  const exhaustedCheckout = `转存 ${ctx.attempted.size} 次后仍未拿到目标集${escalated ? "(AI 介入)" : ""}`;
  stepLog(sandbox, target.title, "结账", exhaustedCheckout);
  emitStep(onProgress, "runCheckout", "finalize", exhaustedCheckout, {
    transfers: ctx.attempted.size,
    fallbackTransfers: ctx.attempted.size - primaryTransfers,
    deadLinkRetries: deadRetries,
    searches: 1 + fallbackRounds,
    aiEscalated: escalated,
  });
  return {
    text: `fast path 未覆盖(尝试 ${ctx.attempted.size} 次转存)`,
    steps: ctx.attempted.size,
    coverage: await sandbox.finish(),
    escalated,
  };
}
