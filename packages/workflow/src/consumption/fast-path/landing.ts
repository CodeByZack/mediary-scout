import type { LanguageModel } from "ai";
import type { gradeCandidates } from "../../acquisition-v2/candidate-grader.js";
import { arbitrateDiagnosis, arbitrateEpisodeMapping } from "../../acquisition-v2/arbitrator.js";
import { finalizeLanding } from "../../acquisition-v2/finalize-landing.js";
import { digestStaging, type StagingDigest } from "../../acquisition-v2/staging-digest.js";
import { normalizeSearchKeyword } from "../../planning-search-gate.js";
import type { AgentToolEvent } from "../../acquisition-v2/activity.js";
import type { TaskSandbox } from "../../acquisition-v2/sandbox.js";
import type { TvAnimeTarget } from "../../acquisition-v2/task-agents.js";
import { MAX_DEAD_LINK_RETRIES, MAX_FALLBACK_SEARCHES } from "./budgets.js";
import {
  compactCodeList,
  compactMapping,
  concludeUncovered,
  pushWithinBudget,
  emitStep,
  evidenceDigestLine,
  gradeDistribution,
  gradedCandidateEvidence,
  landingParseRows,
  nextCandidate,
  stepLog,
  type FastPathResult,
} from "./steps.js";

/**
 * fast path · TV 落地判定层（design §5/§7 consumption/fast-path/landing.ts）。
 * 集数映射（§2.2）、aliases 兜底重搜（§C/§E）、以及从主循环抽出的七值
 * LandingVerdict 落盘收口状态机。日志/emitStep 文案逐字搬迁，零行为变化。
 */

/**
 * 集数映射尝试(§2.2): 代码解析不出集数的落盘(纯数字 `01.mp4` / E01 / fansub),
 * 单季任务第一次收包时让 AI 给逐集映射,校验通过则重建 digest 并尽量归位。
 *
 * 返回值:
 *   - "passed": 映射重建 digest 通过 → 调用方应像干净落地一样 finalize;
 *   - "unmapped-but-clean": 映射唯一且合法,但重建后不覆盖 need → 不是脏包,
 *     换下一个候选;
 *   - "no" / "failed": 非单季、代码已覆盖全部缺集、或映射失败/校验不通过 → 走诊断仲裁。
 *
 * 校验规则(代码,不信任 AI 输出):
 *   1. 文件名必须在本次落盘的全部视频清单里(防幻觉文件名);
 *   2. code 必须 SxxExx 形状且季与任务匹配(单季任务强制赛季一致);
 *   3. 一个集数最多被映射一次(冲突 → 整体放弃该映射,回落仲裁);
 *   4. 映射后的文件必须落在任务的 need/已收集范围内(防 AI 编造不存在的集数)。
 */
export async function tryEpisodeMapping(options: {
  sandbox: TaskSandbox;
  model: LanguageModel;
  digest: StagingDigest;
  seasons: number[];
  targetTitle: string;
  needCodes: string[];
  ram: (overrides: Record<string, string>) => StagingDigest;
  onDigest: (d: StagingDigest) => void;
  /** 映射校验通过后的 clean 表(仅映射合法时回调)——调用方把它喂回
   *  finalizeLanding.overrides,否则 rename/归位按裸文件名解析会跳过这些
   *  fansub/纯数字文件,映射成果落不了地。 */
  onMapping?: (clean: Record<string, string>) => void;
  /** 必填但可为 undefined — 便于 exactOptionalPropertyTypes 下直接传 FastPathOptions.onProgress */
  onProgress: ((event: AgentToolEvent) => void) | undefined;
  /** TMDB 各集播出日(SxxExx → "YYYY-MM-DD")。用于给 AI 推导真实集数范围:
   * 综艺「第N期」在 TMDB 可能一节拆多集(第10期= E19/E20 而非 E10),机械 E(N)
   * 会系统性错位;把全部落盘文件交 AI 重映射时,知道整季真实集号范围才能对齐。 */
  episodeAirDates?: Record<string, string>;
  /** TMDB 各集原始 name(SxxExx→"Episode 10 (Part 1)")—— ram 重建 digest 时透传给
   *  episodeCodeFromFileName 做「第N期」Part 锚定(与年守卫同源)。 */
  episodeNames?: Record<string, string>;
}): Promise<"passed" | "unmapped-but-clean" | "no" | "failed"> {
  const { digest } = options;
  // 仅 TV 单季值得让 AI 映射;movie / 多季 → no。
  if (options.seasons.length !== 1) {
    return "no";
  }

  // ★ 触发条件(2026-08-31 地球超新鲜案修正):不再要求「有 unparsed 才让 AI」——
  // 代码解析可能**错误**(综艺「第N期」被机械解析成 SxxEN,而 TMDB 一期拆多集时
  // 第10期 = E19 而非 E10),解析结果不覆盖 need 时就把**全部视频文件**交给 AI
  // 重新判断,而不是只给「代码解析失败名单」(那样第10期·正片永远从 AI 视野消失)。
  const needSet = new Set(options.needCodes);
  const codeParsedAllNeeds = options.needCodes.every((code) => digest.episodeCodes.includes(code));
  if (codeParsedAllNeeds) {
    return "no"; // 代码已覆盖全部缺集 → 无需 AI。
  }

  const model = options.model;
  // AI 看到的文件 = 全部落盘视频(含代码"已解析"的)减去确认的衍生内容
  // (彩蛋/直拍/加更/预告/广告等——它们本就不该有集号,交给 AI 只会浪费 token)。
  const DERIVATIVE = /(sample|样本|广告|花絮|预告|trailer|彩蛋|直拍|加更|幕后|专访|宣传|前瞻|总宣|花絮|特辑)/i;
  const allFiles = digest.videos
    .map((v) => v.path.split("/").pop() ?? v.path)
    .filter((name) => !DERIVATIVE.test(name));
  if (allFiles.length === 0) {
    return "no"; // 全是衍生内容 → 无正片可映射。
  }

  // 真实集数范围:优先从 TMDB 播出日表推导(E# 的最大值),没有则退回 needCodes。
  const airRanges = options.episodeAirDates
    ? Object.keys(options.episodeAirDates)
        .map((code) => /^S\d{2}E(\d{1,4})$/.exec(code)?.[1])
        .map((n) => (n ? Number(n) : NaN))
        .filter((n) => !Number.isNaN(n))
    : [];
  const knownRange =
    airRanges.length > 0
      ? { min: 1, max: Math.max(...airRanges) }
      : computeKnownEpisodeRange(options.needCodes);
  const arbitration = await arbitrateEpisodeMapping({
    model,
    unparsedFiles: allFiles,
    title: options.targetTitle,
    seasons: options.seasons,
    knownEpisodeRange: knownRange,
  });

  // 校验映射(代码,不信任 AI)。
  const allowed = new Set(allFiles);
  const seenCodes = new Set<string>();
  const clean: Record<string, string> = {};
  let valid = true;
  for (const [fileName, code] of Object.entries(arbitration.mapping)) {
    if (!allowed.has(fileName)) {
      valid = false;
      break;
    }
    if (seenCodes.has(code)) {
      valid = false;
      break;
    }
    // ★ 期号一致性校验(2026-08-31 地球超新鲜假集号案修复):AI 可能把不存在的期硬
    // 安上最新集号(S02E19/E20)迎合 need。当有 episodeNames(TMDB 每集原始 name)时
    // 反查该集号对应的期号 N(TMDB name "Episode N");若文件名里有「第M期」且 M≠N,
    // 说明文件与集号对不上 → 该条映射不采信(整表作废,回落诊断仲裁)。
    if (options.episodeNames) {
      const filePeriod = /第\s*(\d{1,4})\s*期/.exec(fileName)?.[1];
      const tmdbName = options.episodeNames[code];
      const tmdbPeriod = tmdbName ? /Episode\s*(\d{1,4})\b/i.exec(tmdbName)?.[1] : undefined;
      if (
        filePeriod !== undefined &&
        tmdbPeriod !== undefined &&
        Number(filePeriod) !== Number(tmdbPeriod)
      ) {
        const mismatch = `映射期号不符:${fileName}(第${filePeriod}期) → ${code}(TMDB Episode ${tmdbPeriod})`;
        stepLog(options.sandbox, options.targetTitle, "集数映射", mismatch, "warn");
        valid = false;
        break;
      }
    }
    seenCodes.add(code);
    clean[fileName] = code;
  }
  if (!valid) {
    const failDetail = `AI 补认结果与文件名对不上,交给诊断仲裁`;
    stepLog(options.sandbox, options.targetTitle, "集数映射", failDetail, "warn");
    emitStep(options.onProgress, "arbitrateEpisodeMapping", "verify", failDetail, { aiUsed: true, mapping: compactMapping(arbitration.mapping) });
    return "failed";
  }

  // 校验通过的部分映射先交出去:无论重建 digest 是否整体通过,这些映射都是
  // 可信的(AI 确认 + 代码校验过),诊断仲裁 accept 时 finalizeLanding 需要
  // 它们才能让映射的文件 rename/归位。2026-08-21 bugfix:此前只有 "passed"
  // 分支回调 onMapping,部分映射(valid 但重建仍脏)走 accept 时 overrides 为
  // undefined,AI 确认过的文件全部被 staging wipe 清掉(假入库)。
  options.onMapping?.(clean);

  // 重建 digest:overrides 把映射喂回代码解析。
  const re = options.ram(clean);
  options.onDigest(re);
  if (re.passes) {
        // issue #29 用户反馈:人话——AI 根据文件名补认了哪些集,结果如何。
    const mapDetail = `AI 补认:${Object.values(clean).join(",")},目标集数已齐`;
    stepLog(options.sandbox, options.targetTitle, "集数映射", mapDetail, "log");
    emitStep(options.onProgress, "arbitrateEpisodeMapping", "verify", mapDetail, { aiUsed: true, mapping: compactMapping(arbitration.mapping) });
    return "passed";
  }
  if (re.episodeCodes.length > 0 && !re.isDirtyPack) {
    // 映射上了但没覆盖 need(例如映射出的是别的集数)—— 回收干净但无用。
    const mapDetail = `集数映射生效但未覆盖目标(${re.episodeCodes.join(",")}),丢弃换候选`;
    stepLog(options.sandbox, options.targetTitle, "集数映射", mapDetail, "warn");
    emitStep(options.onProgress, "arbitrateEpisodeMapping", "verify", mapDetail, { aiUsed: true, mapping: compactMapping(arbitration.mapping) });
    return "unmapped-but-clean";
  }
  // 重建后仍脏(映射不完整/失败) → 回落诊断仲裁。
    // issue #29 用户反馈:人话——AI 补认后结果如何、为什么要去诊断。
  const failDetail = `AI 补认后仍不完整(${re.summary.split("\n").join(" / ")}),交给诊断仲裁`;
  stepLog(options.sandbox, options.targetTitle, "集数映射", failDetail, "warn");
  emitStep(options.onProgress, "arbitrateEpisodeMapping", "verify", failDetail, { aiUsed: true, mapping: compactMapping(arbitration.mapping) });
  return "failed";
}

/** 从 needCodes(S01E01 形状)推导已知集数范围。 */
export function computeKnownEpisodeRange(needCodes: string[]): { min: number; max: number } | null {
  const numbers = needCodes
    .map((code) => /^S\d{2}E(\d{2,4})$/.exec(code)?.[1])
    .map((n) => (n ? Number(n) : NaN))
    .filter((n) => !Number.isNaN(n));
  if (numbers.length === 0) return null;
  return { min: Math.min(...numbers), max: Math.max(...numbers) };
}

/** rawSnapshotView 的形状(单快照);合并证据池在其上附加 candidateId→snapshotId 归属。 */
type SnapshotView = NonNullable<ReturnType<TaskSandbox["rawSnapshotView"]>>;

export interface EvidenceView extends SnapshotView {
  /** 合并池专用:候选 id → 它真正来自哪个 observed snapshot。缺省 = 全体在 view.snapshotId。 */
  candidateSnapshots?: Record<string, string>;
}

/** 转存的快照寻址:合并池里每个候选回到自己的来源快照,单快照视图零改动。 */
export function candidateSnapshotId(view: EvidenceView, candidateId: string): string {
  return view.candidateSnapshots?.[candidateId] ?? view.snapshotId;
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
export async function aliasesFallbackReSearch(input: {
  sandbox: TaskSandbox;
  title: string;
  aliases: string[];
  view: SnapshotView;
  grading: ReturnType<typeof gradeCandidates>;
  grade: (candidates: Array<{ id: string; title: string }>) => ReturnType<typeof gradeCandidates>;
  onProgress?: (event: AgentToolEvent) => void;
}): Promise<{
  view: EvidenceView;
  grading: ReturnType<typeof gradeCandidates>;
  rounds: number;
  restored: boolean;
}> {
  const { sandbox, title, aliases, view, grading, grade, onProgress } = input;
  const searched = new Set<string>([normalizeSearchKeyword(title)]);
  let currentView = view;
  let currentGrading = grading;
  let rounds = 0;
  let foundUniqueA = false;
  const roundViews: SnapshotView[] = [];
  for (const alias of aliases) {
    if (rounds >= MAX_FALLBACK_SEARCHES) break;
    const keyword = normalizeSearchKeyword(alias);
    if (keyword === "" || searched.has(keyword)) continue; // 用过的词去重
    searched.add(keyword);
    rounds += 1;
    const roundDetail = `keyword=「${alias}」(第 ${rounds}/${MAX_FALLBACK_SEARCHES} 轮)`;
    stepLog(sandbox, title, "兜底重搜", roundDetail);
    // issue #29 用户实测:searchResources 与随后的 gradeCandidates 同关键词重复,
    // activity 只留 gradeCandidates 一条(带命中结果),此步仅留表格排障日志。
    try {
      await sandbox.primeRawSnapshot(alias);
    } catch (error) {
      // Provider down on a fallback round — keep the current snapshot and try the
      // next alias (bounded by the budget; a dead source never kills the run).
      const failDetail = `keyword=「${alias}」搜索失败:${error instanceof Error ? error.message : String(error)}`;
      stepLog(sandbox, title, "兜底重搜", failDetail, "warn");
      continue;
    }
    const nextView = sandbox.rawSnapshotView();
    if (!nextView) continue; // defensive: prime succeeded, so a view must exist
    currentView = nextView;
    roundViews.push(nextView);
    currentGrading = grade(nextView.candidates);
    const gradeDetail = `keyword=「${alias}」命中=${nextView.candidates.length} ${
      currentGrading.uniqueTopGrade
        ? `唯一 A 级《${currentGrading.top?.title}》` // issue #29 铁律①:候选 ID 全链不上 UI,只留标题。
        : gradeDistribution(currentGrading)
    }`;
    stepLog(sandbox, title, "兜底评分", gradeDetail);
    if (currentGrading.ranked.length > 0) {
      stepLog(sandbox, title, "兜底命中", evidenceDigestLine(currentGrading));
    }
    // issue #29:兜底轮是不同关键词的搜索结果(信息价值),保留列表并补链接保持全链可点。
    const roundUrlById: Record<string, string> = {};
    for (const c of nextView.candidates) {
      if (c.url) roundUrlById[c.id] = c.url;
    }
    emitStep(onProgress, "gradeCandidates", "search", gradeDetail, {
      keyword: alias,
      candidates: gradedCandidateEvidence(currentGrading, roundUrlById),
    });
    if (nextView.candidates.length > 0 && currentGrading.uniqueTopGrade) {
      foundUniqueA = true;
      break; // 唯一 A → 直接转存
    }
  }
  // §E: 兜底耗尽仍无唯一 A → 合并 primary + 各轮兜底 的证据池继续仲裁/放弃逻辑。
  // 旧行为(替换式恢复)两头都出过事故:「最后一个兜底快照为空」覆盖 primary 让
  // 狂飙 45 条候选被丢;反过来只恢复/只看最后一轮,又会吞掉另一侧的好候选
  // (母狮案:兜底第 1 轮搜到「1-3季合集」,恢复 primary 后仲裁根本见不到它)。
  // 合并纯内存操作、按标题去重、primary 优先入池;各轮候选带着自己 observed
  // snapshot 的归属回传给转存寻址(candidateSnapshotId)——零额外 PanSou 请求,
  // 预算语义原样保持。
  if (!foundUniqueA) {
    const candidateSnapshots: Record<string, string> = {};
    const merged: Array<{ id: string; title: string }> = [];
    let primaryCount = 0;
    let fallbackCount = 0;
    const addAll = (source: SnapshotView, fromFallback: boolean) => {
      for (const candidate of source.candidates) {
        // 只按 id 去重(跨快照 id 天然不同,同 id 只留首次来源)。不按标题去重:
        // 同名异链是网盘资源常态,标题去重会把后轮快照里的合法候选 id 误删,
        // 仲裁选中即触发假 id 防御(预算 ≤3 测试现场抓到的回归)。
        if (candidateSnapshots[candidate.id] !== undefined) continue;
        candidateSnapshots[candidate.id] = source.snapshotId;
        merged.push(candidate);
        if (fromFallback) fallbackCount += 1;
        else primaryCount += 1;
      }
    };
    addAll(view, false);
    for (const roundView of roundViews) addAll(roundView, true);
    if (merged.length > 0) {
      const mergedView: EvidenceView = { snapshotId: view.snapshotId, candidates: merged, candidateSnapshots };
      const mergedGrading = grade(merged);
      const restoreDetail = `兜底耗尽,合并证据池(primary ${primaryCount} + 兜底 ${fallbackCount})`;
      stepLog(sandbox, title, "兜底重搜", restoreDetail);
      // issue #29 用户实测:合并证据池不单独成步(与随后的兜底评分重复),交给调用方一条带出。
      return { view: mergedView, grading: mergedGrading, rounds, restored: true };
    }
  }
  return { view: currentView, grading: currentGrading, rounds, restored: false };
}

/**
 * TV 落地收口状态机（design §5 LandingVerdict）：一个候选的落地回合内，
 * digest → 集数映射(§2.2) → 诊断仲裁 → finalize/丢弃，收敛为七种判定：
 *   systemic(系统阻塞) / dead(死链探测) / clean(干净落地) / mapped_clean(映射通过)
 *   / accept(诊断 accept) / retry_other(换候选续跑) / abandon(诚实终止)。
 * done 非空 = 本轮终局（调用方直接 return）；done=null 用 next 继续循环。
 * escalated/deadRetries 随判定带出，循环侧统一回收 —— 预算语义原样
 * （死链不占转存预算：dead 分支不触 attempted.add）。
 */
export type LandingVerdict =
  | "systemic"
  | "dead"
  | "clean"
  | "mapped_clean"
  | "accept"
  | "retry_other"
  | "abandon";

export interface TvCloseOut {
  verdict: LandingVerdict;
  /** 非空 = 终局结论（含当轮 escalated）。 */
  done: FastPathResult | null;
  /** done=null 时推进的候选（null = 无下一候选，循环自然收敛到耗尽尾段）。 */
  next: string | null;
  escalated: boolean;
  deadRetries: number;
}

export async function closeOutTvLanding(options: {
  sandbox: TaskSandbox;
  model: LanguageModel;
  target: TvAnimeTarget;
  onProgress: ((event: AgentToolEvent) => void) | undefined;
  seasons: number[];
  needCodes: string[];
  onDiskCodes: Set<string>;
  /** TMDB 各集播出日(SxxExx→"YYYY-MM-DD",可缺省)—— digest/finalize 共用的年守卫数据。 */
  episodeAirDates?: Record<string, string>;
  /** TMDB 各集原始 name(SxxExx→"Episode 10 (Part 1)")——「第N期」Part 锚定数据。 */
  episodeNames?: Record<string, string>;
  grading: ReturnType<typeof gradeCandidates>;
  tried: Set<string>;
  attempted: Set<string>;
  current: string;
  escalated: boolean;
  deadRetries: number;
  transfer: Awaited<ReturnType<TaskSandbox["transferCandidate"]>>;
}): Promise<TvCloseOut> {
  const {
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
    transfer,
  } = options;
  const current = options.current;
  let escalated = options.escalated;
  let deadRetries = options.deadRetries;

    // Systemic block (quota/auth/VIP) — every remaining candidate fails the same
    // way; stop grinding.
    if (transfer.systemicBlock) {
      const blockDetail = `系统阻塞:${transfer.systemicBlock.reason}`;
      stepLog(sandbox, target.title, "转存失败", blockDetail, "error");
      const doneDetail = `失败(系统阻塞:${transfer.systemicBlock.reason})`;
      stepLog(sandbox, target.title, "结论", doneDetail);
      // issue #29 A3:systemic 也是转存轮事件,补 round 防前端误判为老数据序号卡。
      emitStep(onProgress, "transferCandidate", "transfer", blockDetail, {
        candidateId: current,
        round: attempted.size + 1,
        decidedBy: grading.uniqueTopGrade ? "code" : "ai",
      });
      emitStep(onProgress, "finish", "finalize", doneDetail);
      return { verdict: "systemic", done: {
        text: `系统阻塞:${transfer.systemicBlock.reason}`,
        steps: attempted.size,
        coverage: await sandbox.finish(),
        escalated,
      }, next: null, escalated, deadRetries };
    }

    // Dead link (nothing landed) — a cheap probe, not a transfer attempt; advance
    // to the next candidate until the dead-link scan cap or the pool is exhausted.
    if (transfer.staging.length === 0) {
      deadRetries += 1;
      const next = nextCandidate(grading, tried);
      // issue #29:死链提示不显示候选 ID(AI 补认也可来自 grading.ranked 标题;找不到退「该候选」)。
      const deadTitle = grading.ranked.find((c) => c.id === current)?.title ?? "该候选";
      const deadDetail = `《${deadTitle}》死链(转存未落盘)${next ? `,重试换一条候选(${deadRetries}/${MAX_DEAD_LINK_RETRIES})` : ",没有可换的"}`;
      stepLog(sandbox, target.title, "转存失败", deadDetail, "warn");
      // issue #29 A3:dead 探针也归当前轮。
      emitStep(onProgress, "transferCandidate", "transfer", deadDetail, {
        candidateId: current,
        round: attempted.size + 1,
        decidedBy: grading.uniqueTopGrade ? "code" : "ai",
      });
      const probeDetail = `该候选转存返回 0 个落盘文件 → 判死链(探测第 ${deadRetries}/${MAX_DEAD_LINK_RETRIES} 次,不占转存预算)${next ? "" : ";池内无下一候选"}`;
      stepLog(sandbox, target.title, "死链探测", probeDetail, "warn");
      return { verdict: "dead", done: null, next, escalated, deadRetries };
    }

    // A real transfer happened — this is the countable attempt.
    attempted.add(current);
    const digest = digestStaging({
      files: transfer.staging,
      seasons,
      needCodes,
      ...(options.episodeAirDates !== undefined ? { episodeAirDates: options.episodeAirDates } : {}),
      ...(options.episodeNames !== undefined ? { episodeNames: options.episodeNames } : {}),
    });
    // issue #29 用户反馈:activity 人话化——直接复用 summarizeDigest 的人话结论
    // (pass=「转存内容已识别…」/ fail=「识别出…还缺…」),与 args 的 missingCodes 一致,
    // 不再自造「转存内容完整」双源文案(部分覆盖时曾谎报完整,复核揪出)。
    const digestDetail = digest.summary;
    stepLog(
      sandbox,
      target.title,
      "digest 验证",
      digestDetail,
      digest.passes ? "log" : "warn",
    );
    // issue #29:digest 步骤结构化证据(卡片化判定)。videoCount=落盘视频文件数;
    // passes/coveredCodes/missingCodes 给前端红绿判定与「还缺什么」。
    emitStep(onProgress, "stagingDigest", "verify", digestDetail, {
      passes: digest.passes,
      videoCount: transfer.staging.length,
      // issue #29 预算化(A1):长篇动漫整包入库 covered/missing 可达 100+,直接平铺会触发
      // agent-trace-sink 的 2000 字符整体塌缩 → passes/round 一起丢。改发 count + 前 N 项。
      coveredCodes: compactCodeList(digest.coveredCodes),
      missingCodes: compactCodeList(digest.missingCodes),
      round: attempted.size,
    });
    const parseRows = landingParseRows(transfer.staging, seasons, options.episodeAirDates);
    if (parseRows.length > 0) {
      stepLog(sandbox, target.title, "解析明细", parseRows.join(" / "));
      // M6:stepLog 的 parseRows 已按 1850 预算(stdout),但进 args 时被 {files,round} 包裹,
      // 距 agent-trace-sink 的 2000 字符整体塌缩只剩 ~150——args 侧单独收紧到 1300。
      // M6(修正):args 侧只截断、不加「未列」汇总行——stdout 的 parseRows 已有总计数,
      // 二次截断再加会双条「未列」且把 stdout 汇总行计入。总数在 activity 文案里已有。
      const argsFiles = pushWithinBudget<string>([], parseRows, 1300);
      emitStep(onProgress, "digestFiles", "verify", `逐文件识别 ${parseRows.length} 条`, { files: argsFiles, round: attempted.size });
    }
    {
      const candidate = grading.ranked.find((c) => c.id === current);
      if (
        candidate &&
        candidate.seasonNumbers.length === 0 &&
        /\d/.test(candidate.title) &&
        parseRows.some((row) => row.includes("⚠"))
      ) {
        stepLog(
          sandbox,
          target.title,
          "季号提示",
          `候选标题「${candidate.title.slice(0, 60)}」含数字但季号未被评分器识别,落盘又按目标季解释——假入库风险面(issue #21)`,
          "warn",
        );
      }
    }

    // Clean landing → finalize (rename/归位/mark/wipe) in code, zero LLM.
    if (digest.passes) {
      try {
        const finalized = await finalizeLanding({
          sandbox,
          digest,
          canonicalTitle: target.title,
          seasons,
          skipCodes: [...onDiskCodes],
          onlyCodes: needCodes,
          ...(options.episodeAirDates !== undefined ? { episodeAirDates: options.episodeAirDates } : {}),
        });
        const skipNote =
          (finalized.skippedOnDisk.length > 0
            ? ` / 已在库跳过 ${finalized.skippedOnDisk.length} 集(${finalized.skippedOnDisk.sort().join(",")})`
            : "") +
          (finalized.skippedNotNeeded.length > 0
            ? ` / 非缺集跳过 ${finalized.skippedNotNeeded.length} 件`
            : "");
                // issue #29 用户反馈:finalizeLanding 是「真正落到网盘」的一步(rename→move→mark),
        // 文案点明归位到 Season 目录 + 结果,不再用「标记/移动/清理」割裂的内部词。
        const organizeDetail = `归位到 Season 目录:${finalized.marked.join(",") || "-"}${finalized.movedCount > 0 ? `,移动 ${finalized.movedCount} 个文件` : ""}${finalized.discarded.length > 0 ? `,清理 ${finalized.discarded.length} 个多余文件` : ""}${skipNote}`;
        stepLog(sandbox, target.title, "归位", organizeDetail);
        // issue #29 实测:归位步骤展示 rename 明细(原名 → 规范名),预算内截断。
        const renameRows = finalized.renamedPairs.map((rp) => `${rp.from} → ${rp.to}`);
        emitStep(onProgress, "finalizeLanding", "organize", organizeDetail, {
          ok: true,
          files: pushWithinBudget<string>([], renameRows, 1300),
        });
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
        emitStep(onProgress, "finalizeLanding", "organize", organizeFailDetail, { ok: false });
        const doneDetail = `失败(归位异常:${error instanceof Error ? error.message : String(error)})`;
        stepLog(sandbox, target.title, "结论", doneDetail);
        emitStep(onProgress, "reportNoCoverage", "finalize", doneDetail);
        return { verdict: "abandon", done: await concludeUncovered(sandbox, {
          text: `fast path 归位失败:${error instanceof Error ? error.message : String(error)}`,
          steps: attempted.size,
          escalated,
          reason: error instanceof Error ? error.message : String(error),
        }), next: null, escalated, deadRetries };
      }
            // issue #29 用户反馈:finish 人话——不再「入库(obtained=…)」,直接说收到了哪几集。
      const doneDetail = `已完成:${digest.coveredCodes.join(",") || "-"} 已入库`;
      stepLog(sandbox, target.title, "结论", doneDetail);
      emitStep(onProgress, "finish", "finalize", doneDetail);
      return { verdict: "clean", done: {
        text: `fast path 归位标记:${digest.coveredCodes.join(",") || "-"}`,
        steps: attempted.size,
        coverage: await sandbox.finish(),
        escalated,
      }, next: null, escalated, deadRetries };
    }

    // Dirty / off-target landing. TV-only, single-season: if the landing has
    // videos the CODE cannot parse into episode codes (纯数字 `01.mp4` / E01 /
    // 日漫 fansub), the fast path first asks the AI for a 逐集映射 (§2.2) —
    // the design intent the old agent loop had ("you can read that
    // [NC-Raws] Lyricis Recoil - 01.mkv is S01E01"). A verified mapping lets the
    // pack land like a clean digest (zero further LLM decisions); a failed or
    // partial mapping falls through to the diagnostic arbitrator.
    // Movie landings never map episodes — they go straight to the movie diagnosis.
    escalated = true;
    let landingDigest = digest;
    let mappingTable: Record<string, string> | undefined;
    const mappingEscalated = await tryEpisodeMapping({
      sandbox,
      model,
      digest,
      seasons,
      targetTitle: target.title,
      needCodes,
      ...(options.episodeAirDates !== undefined ? { episodeAirDates: options.episodeAirDates } : {}),
      ...(options.episodeNames !== undefined ? { episodeNames: options.episodeNames } : {}),
      ram: (overrides) =>
        digestStaging({
          files: transfer.staging,
          seasons,
          needCodes,
          overrides,
          ...(options.episodeAirDates !== undefined ? { episodeAirDates: options.episodeAirDates } : {}),
          ...(options.episodeNames !== undefined ? { episodeNames: options.episodeNames } : {}),
        }),
      onDigest: (d) => {
        landingDigest = d;
      },
      onMapping: (clean) => {
        mappingTable = clean;
      },
      onProgress,
    });
    if (mappingEscalated === "passed") {
      // Wiped via overrides — same close-out as a clean landing (rename/归位/mark).
      try {
        const finalized = await finalizeLanding({
          sandbox,
          digest: landingDigest,
          canonicalTitle: target.title,
          seasons,
          skipCodes: [...onDiskCodes],
          onlyCodes: needCodes,
          ...(options.episodeAirDates !== undefined ? { episodeAirDates: options.episodeAirDates } : {}),
          ...(mappingTable ? { overrides: mappingTable } : {}),
        });
        const skipNote =
          (finalized.skippedOnDisk.length > 0
            ? ` / 已在库跳过 ${finalized.skippedOnDisk.length} 集(${finalized.skippedOnDisk.sort().join(",")})`
            : "") +
          (finalized.skippedNotNeeded.length > 0
            ? ` / 非缺集跳过 ${finalized.skippedNotNeeded.length} 件`
            : "");
        // issue #29:与干净路径(:535)同款人话——归位到 Season 目录(真正落库)。
        const organizeDetail = `归位到 Season 目录:${finalized.marked.join(",") || "-"}${finalized.movedCount > 0 ? `,移动 ${finalized.movedCount} 个文件` : ""}${finalized.discarded.length > 0 ? `,清理 ${finalized.discarded.length} 个多余文件` : ""}${skipNote}`;
        stepLog(sandbox, target.title, "归位", organizeDetail);
        // issue #29 实测:与干净路径同款——rename 明细(原名 → 规范名)。
        const renameRows2 = finalized.renamedPairs.map((rp) => `${rp.from} → ${rp.to}`);
        emitStep(onProgress, "finalizeLanding", "organize", organizeDetail, {
          ok: true,
          files: pushWithinBudget<string>([], renameRows2, 1300),
        });
      } catch (error) {
        try {
          await sandbox.discardStaging();
        } catch {
          // already empty.
        }
        const organizeFailDetail = error instanceof Error ? error.message : String(error);
        stepLog(sandbox, target.title, "归位失败", organizeFailDetail, "error");
        emitStep(onProgress, "finalizeLanding", "organize", organizeFailDetail, { ok: false });
        const doneDetail = `失败(归位异常:${error instanceof Error ? error.message : String(error)})`;
        stepLog(sandbox, target.title, "结论", doneDetail);
        emitStep(onProgress, "reportNoCoverage", "finalize", doneDetail);
        return { verdict: "abandon", done: await concludeUncovered(sandbox, {
          text: `fast path 归位失败:${error instanceof Error ? error.message : String(error)}`,
          steps: attempted.size,
          escalated,
          reason: error instanceof Error ? error.message : String(error),
        }), next: null, escalated, deadRetries };
      }
            // issue #29:人话——AI 补认后这几集已入库。
      const doneDetail = `已完成:${landingDigest.coveredCodes.join(",") || "-"} 已入库(AI 补认)`;
      stepLog(sandbox, target.title, "结论", doneDetail);
      emitStep(onProgress, "finish", "finalize", doneDetail);
      return { verdict: "mapped_clean", done: {
        text: `集数映射归位:${landingDigest.coveredCodes.join(",") || "-"}`,
        steps: attempted.size,
        coverage: await sandbox.finish(),
        escalated,
      }, next: null, escalated, deadRetries };
    }
    if (mappingEscalated === "unmapped-but-clean") {
      // 映射成功但没覆盖 need → 不是脏包了,但也没拿到需要的集 → 换候选。
      const leftover = await sandbox.inspectStaging();
      if (leftover.length > 0) {
        await sandbox.deleteFiles({ directory: "staging", fileIds: leftover.map((f) => f.id) });
      }
      const next = nextCandidate(grading, tried);
      // issue #29:换候选不显示 ID(人话)。
      const retryDetail = `这轮转存没拿到需要的集:清掉暂存,换一条候选${next ? "" : "(没有可换的,终止)"}`;
      stepLog(sandbox, target.title, "仲裁", retryDetail, "warn");
      emitStep(onProgress, "arbitrateEpisodeMapping", "pick", retryDetail, { round: attempted.size });
      return { verdict: "retry_other", done: null, next, escalated, deadRetries };
    }

    const diagnosis = await arbitrateDiagnosis({
      model,
      summary: landingDigest.summary,
      title: target.title,
      // 功能4: 把剩余候选按分级喂给诊断仲裁,retry_other 时一次挑出下一个,
      // 避免每个脏包都重新仲裁(45 候选只试 3 次的教训)。
      remainingCandidates: grading.ranked.map((c) => ({
        id: c.id,
        title: c.title,
        grade: c.grade,
      })),
      triedIds: [...tried],
    });
    if (diagnosis.action === "accept") {
      try {
        // 2026-08-21 bugfix: 必须把 AI 集数映射的 overrides 传给 finalizeLanding ——
        // 否则纯数字/日漫 fansub 文件名(如 `08.mkv`)在诊断仲裁 accept 后重新用裸
        // 文件名解析时依然解析不出(S03 任务纯数字规则本就禁猜),文件不 rename/
        // 不归位/不 mark,最后被 staging wipe 当垃圾清掉 → 日志写"入库"实际没入库。
        // 与上方 mappingEscalated === "passed" 分支保持一致。
        const arAccept = await finalizeLanding({
          sandbox,
          digest: landingDigest,
          canonicalTitle: target.title,
          seasons,
          skipCodes: [...onDiskCodes],
          onlyCodes: needCodes,
          ...(options.episodeAirDates !== undefined ? { episodeAirDates: options.episodeAirDates } : {}),
          ...(mappingTable ? { overrides: mappingTable } : {}),
        });
        // issue #29 用户实测复核揪出:诊断仲裁 accept 分支此前漏了 finalizeLanding 的
        // 成功 emit —— rename/归位/mark 都执行了,但 UI 看不到「归位到 Season 目录」
        // 步骤和 rename 明细。与 passed/干净路径同款补上。
        const arSkipNote =
          (arAccept.skippedOnDisk.length > 0
            ? ` / 已在库跳过 ${arAccept.skippedOnDisk.length} 集(${arAccept.skippedOnDisk.sort().join(",")})`
            : "") +
          (arAccept.skippedNotNeeded.length > 0
            ? ` / 非缺集跳过 ${arAccept.skippedNotNeeded.length} 件`
            : "");
        const arOrganizeDetail = `归位到 Season 目录:${arAccept.marked.join(",") || "-"}${arAccept.movedCount > 0 ? `,移动 ${arAccept.movedCount} 个文件` : ""}${arAccept.discarded.length > 0 ? `,清理 ${arAccept.discarded.length} 个多余文件` : ""}${arSkipNote}`;
        stepLog(sandbox, target.title, "归位", arOrganizeDetail);
        const arRenameRows = arAccept.renamedPairs.map((rp) => `${rp.from} → ${rp.to}`);
        emitStep(onProgress, "finalizeLanding", "organize", arOrganizeDetail, {
          ok: true,
          files: pushWithinBudget<string>([], arRenameRows, 1300),
        });
      } catch (error) {
        try {
          await sandbox.discardStaging();
        } catch {
          // already empty.
        }
        const organizeFailDetail = error instanceof Error ? error.message : String(error);
        stepLog(sandbox, target.title, "归位失败", organizeFailDetail, "error");
        emitStep(onProgress, "finalizeLanding", "organize", organizeFailDetail, { ok: false });
        const doneDetail = `失败(归位异常:${error instanceof Error ? error.message : String(error)})`;
        stepLog(sandbox, target.title, "结论", doneDetail);
        emitStep(onProgress, "reportNoCoverage", "finalize", doneDetail);
        return { verdict: "abandon", done: await concludeUncovered(sandbox, {
          text: `fast path 归位失败:${error instanceof Error ? error.message : String(error)}`,
          steps: attempted.size,
          escalated,
          reason: error instanceof Error ? error.message : String(error),
        }), next: null, escalated, deadRetries };
      }
            // issue #29:人话——仲裁同意后这几集已入库,理由附后。
      // issue #29 用户拍板:finish 要人话 + 报出具体集数(有值时);空则只给理由。
      const acceptCodes = landingDigest.coveredCodes.length > 0 ? landingDigest.coveredCodes.join(",") + " " : "";
      const doneDetail = `已完成:${acceptCodes}已入库(${diagnosis.reasoning})`;
      stepLog(sandbox, target.title, "结论", doneDetail);
      emitStep(onProgress, "finish", "finalize", doneDetail);
      return { verdict: "accept", done: {
        text: `${diagnosis.reasoning}`,
        steps: attempted.size,
        coverage: await sandbox.finish(),
        escalated,
      }, next: null, escalated, deadRetries };
    }
    if (diagnosis.action === "abandon") {
      await sandbox.discardStaging();
      const declineDetail = `放弃:${diagnosis.reasoning}`;
      stepLog(sandbox, target.title, "仲裁", declineDetail, "warn");
      const doneDetail = `放弃:${diagnosis.reasoning}`;
      stepLog(sandbox, target.title, "结论", doneDetail);
      emitStep(onProgress, "arbitrateDiagnosis", "pick", declineDetail, { round: attempted.size });
      emitStep(onProgress, "reportNoCoverage", "finalize", doneDetail);
      return { verdict: "abandon", done: await concludeUncovered(sandbox, {
        text: `放弃:${diagnosis.reasoning}`,
        steps: attempted.size,
        escalated,
        reason: diagnosis.reasoning,
      }), next: null, escalated, deadRetries };
    }
    // retry_other → clear the bad pack's files (keep the staging dir alive) and
    // try the next candidate. 功能4: AI 已随仲裁返回 nextCandidateId 就直接用它
    // (需校验:候选存在、未尝试过),否则才回退机械按序 nextCandidate。
    const leftover = await sandbox.inspectStaging();
    if (leftover.length > 0) {
      await sandbox.deleteFiles({ directory: "staging", fileIds: leftover.map((f) => f.id) });
    }
    const aiNext =
      diagnosis.nextCandidateId &&
      grading.ranked.some((c) => c.id === diagnosis.nextCandidateId) &&
      !tried.has(diagnosis.nextCandidateId)
        ? diagnosis.nextCandidateId
        : null;
    const next = aiNext ?? nextCandidate(grading, tried);
    // issue #29:中文人话 + 不显示候选 ID。
    const retryDetail = `这轮内容不对:清掉暂存换一条候选${next ? "" : "(没有可换的,终止)"}${aiNext ? " (AI 指定)" : ""}`;
    stepLog(sandbox, target.title, "仲裁", retryDetail, "warn");
    emitStep(onProgress, "arbitrateDiagnosis", "pick", retryDetail, { round: attempted.size });
    return { verdict: "retry_other", done: null, next, escalated, deadRetries };
}
