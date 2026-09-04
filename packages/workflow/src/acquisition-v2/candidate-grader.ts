import { normalizeForTitleMatch } from "../planning-search-gate.js";

/**
 * Candidate grading for the fast path (zero-LLM acquisition). The agent used to
 * "pick from 300 candidates" by reading the full PanSou snapshot into context —
 * this module does that ranking in CODE instead, so the fast path can transfer a
 * single obvious match without ever calling the LLM, and only escalates to the
 * selection arbitrator when the rules cannot decide (no A-grade).
 *
 * The grading rules (§6.3) are all mechanical: normalized title match + a
 * season/episode-code regex + a Chinese-sub marker regex + a dead-link/same-work
 * rejection. The marker regexes live here now (they used to exist only as prompt
 * text in task-agents.ts / skill.ts) so code and prompt share one source of truth.
 */

/** A candidate as the provider hands it to the sandbox — id + title only. */
export interface GradableCandidate {
  id: string;
  title: string;
}

export type CandidateGrade = "A" | "B" | "C" | "D";

export interface GradedCandidate {
  id: string;
  title: string;
  grade: CandidateGrade;
  /** Monotone rank key (higher = better); used to break ties within a grade. */
  score: number;
  /** Human-readable reasons for the grade (surfaced to the arbitrator when escalated). */
  reasons: string[];
  /** Whether the release name signals Chinese subtitles (or the work is natively
   *  Chinese-spoken). A key "中字 OK" input to the A-grade decision. */
  hasChineseSub: boolean;
  /** Season numbers the release title names (e.g. `["第一季"]` → [1]). Empty = no
   *  explicit season marker (a full-series pack or season-1 default). */
  seasonNumbers: number[];
  /** The quality token found in the title (e.g. "1080P", "4K"), if any. */
  quality: string | null;
}

export interface GradingContext {
  title: string;
  aliases: string[];
  /** The season numbers this task covers. Empty array = do not gate on season
   *  (e.g. a movie, or a first-acquisition full-series task where any pack works). */
  seasons: number[];
  /** CN-origin works are natively Chinese-spoken — no 中字 to hunt, so the
   *  Chinese-sub signal is not required for an A grade. */
  isChineseNative?: boolean;
  /** Movie release year (TMDB). When set, grading flips to movie mode: identity
   *  is title + year (a year mismatch downgrades the 同名异作/remake trap; a
   *  year-less release stays a plausible B, never auto-killed). `0`/negative =
   *  year unknown → title match alone is a B (cannot verify identity). */
  year?: number;
}

export interface GradingResult {
  /** All candidates, ranked best-first (A > B > C > D, then score desc). */
  ranked: GradedCandidate[];
  /** True when the best-ranked candidate is A — the fast path can pick it by score
   *  without AI escalation. Zero A-grades (top is B/C/D) means "escalate". */
  uniqueTopGrade: boolean;
  /** The single A-grade candidate when uniqueTopGrade, else the best candidate. */
  top: GradedCandidate | null;
}

/** Chinese-sub / release markers. CJK presence means "Chinese-community release"
 *  which (per the languageLine rule) ships Chinese subs by default — do not treat
 *  the absence of the literal "中字" token as proof of raw. */
const CHINESE_SUB_MARKER = /中字|国语|双语|简繁|中英|国粤|内封|CHS|简体|繁体/i;
const CHINESE_CHAR = /[\u4e00-\u9fff]/;

/** Quality tokens the release title may carry (post-recall read, never a search
 *  term — mirrors QUALITY_SUBTITLE_TOKEN in sandbox.ts). */
const QUALITY_MARKER =
  /\b(4k|2160p|1080p|720p|hdr|dv|remux|web-?dl|bluray|bdrip)\b|蓝光|超清|高清/i;

/** Episode / series-coverage markers — a release that names concrete episodes or
 *  declares a full pack is evidence it actually contains the work. */
const EPISODE_CODE_MARKER = /[Ss]\d{1,2}[Ee]\d{1,4}|第\s*\d{1,4}\s*(?:集|期)/;
const COMPLETE_MARKER = /全集|全\s*\d+\s*集|complete|完结|更新至|全季/i;

/** A release that names a DIFFERENT work from the same IP — the classic 同名异作
 *  trap (狂飙 电影版 when tracking the TV series; 凡人修仙传 真人版 when tracking the
 *  国漫). These can never be the tracked target. */
const DIFFERENT_WORK_MARKER =
  /电影版|剧场版|OVA|特别篇|番外|外传|前传|衍生|真人版|\bSP\b|特别版|剪辑版/i;

/** Season markers — `第N季`, `Sxx`, `Season N`, plus the invisible-season forms
 *  of issue #21 (`3.全集`, bare `N季`, range `1-10季`). */
const SEASON_MARKER_SXX = /[Ss](\d{1,2})/;
const SEASON_MARKER_CN = /第\s*([一二三四五六七八九十\d]+)\s*季/;
const SEASON_MARKER_EN = /\bseason\s*(\d{1,2})\b/i;
/** 隐形季号(issue #21):`奇异新世界3.全集` — 紧贴「全集/合集」的季号。`(?<!\d)`
 *  让年份不中(`2019.全集` 里的 19 前有数字);「全20集」没有数字+点+全集形态,不中。 */
const SEASON_MARKER_DOT = /(?<!\d)(\d{1,2})\s*[.．]\s*(?:全集|合集)/;
/** 裸 `N季`(不带「第」):排除范围前缀(`1-10季` 的 10 前是连字符)、年份(`2025季`
 *  的 25 前是数字)、总季数声明(`全10季`/`共3季` — 那是"共几季",不指向某一季)。 */
const SEASON_MARKER_PLAIN = /(?<![\d.\-–~全共])(\d{1,2})\s*季/;
/** 季范围 `1-10季`/`5~8季`:只用于"范围不含目标季 → 降级",不作为 A 级季证据 ——
 *  合集包内容构成不可信(2026-08-30 中餐厅:"1-10季"包实际只转到第九季目录)。 */
const SEASON_MARKER_RANGE = /(?<!\d)(\d{1,2})\s*[-–~至]\s*(\d{1,2})\s*季/;

/** A release year embedded in the title — `(2023)`, `2023年`, `Title.2008.1080p`.
 *  `\b` bounds it so a resolution string (`1920x1080`) never reads as year 1920
 *  (the trailing `0x` has no word boundary). Movies live in 19xx/20xx. */
const YEAR_MARKER = /\b(?:19|20)\d{2}\b/;

const CN_DIGITS: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

/** Parse a Chinese numeral (1-10 supported; "十" and single digits cover the
 *  realistic season range) into a number. */
function cnToNumber(value: string): number {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  if (trimmed.length === 1 && CN_DIGITS[trimmed] !== undefined) {
    return CN_DIGITS[trimmed]!;
  }
  if (trimmed === "十") {
    return 10;
  }
  return Number.NaN;
}

/** Season numbers named in a candidate title. */
export function seasonNumbersInTitle(title: string): number[] {
  const found: number[] = [];
  const cn = SEASON_MARKER_CN.exec(title);
  if (cn?.[1]) {
    const n = cnToNumber(cn[1]);
    if (!Number.isNaN(n)) found.push(n);
  }
  const sxx = SEASON_MARKER_SXX.exec(title);
  if (sxx?.[1]) {
    const n = Number(sxx[1]);
    if (n >= 1 && n <= 99) found.push(n);
  }
  const en = SEASON_MARKER_EN.exec(title);
  if (en?.[1]) {
    const n = Number(en[1]);
    if (n >= 1) found.push(n);
  }
  // issue #21:隐形季号两种形态,让「3.全集」「3季」的 3 也被看见,喂给现成的
  // mismatch→C 闸门(S01/S02 任务下假 A 消失;真对季时它本来就是对的)。
  const dot = SEASON_MARKER_DOT.exec(title);
  if (dot?.[1]) {
    const n = Number(dot[1]);
    if (n >= 1 && n <= 99) found.push(n);
  }
  const plain = SEASON_MARKER_PLAIN.exec(title);
  if (plain?.[1]) {
    const n = Number(plain[1]);
    if (n >= 1 && n <= 99) found.push(n);
  }
  return [...new Set(found)];
}

/** 标题里的季范围(`1-10季` → [1,10]),无则 null。范围只参与 mismatch 降级,
 *  不算点名单季的证据(见 SEASON_MARKER_RANGE 注释)。 */
export function seasonRangeInTitle(title: string): [number, number] | null {
  const match = SEASON_MARKER_RANGE.exec(title);
  const lo = match?.[1] ? Number(match[1]) : Number.NaN;
  const hi = match?.[2] ? Number(match[2]) : Number.NaN;
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < 1 || hi < 1) return null;
  return [Math.min(lo, hi), Math.max(lo, hi)];
}

/** The release year embedded in a candidate title (19xx/20xx), or null when the
 *  title carries none. Movie identity anchor — a year-less release is a legit but
 *  unverifiable candidate (never auto-killed), while a mismatched year flags the
 *  同名异作/remake. */
export function yearInTitle(title: string): number | null {
  YEAR_MARKER.lastIndex = 0;
  const match = YEAR_MARKER.exec(title);
  YEAR_MARKER.lastIndex = 0;
  return match ? Number(match[0]) : null;
}

/** Whether the candidate title names the target work (title or an alias), after
 *  the same normalization keywordReferencesTitle uses. */
function titleMatches(title: string, context: GradingContext): boolean {
  const terms = [context.title, ...context.aliases]
    .map(normalizeForTitleMatch)
    .filter((term) => term.length > 0);
  if (terms.length === 0) {
    return true; // fail open — no title terms to match against
  }
  const candidate = normalizeForTitleMatch(title);
  return terms.some((term) => candidate.includes(term));
}

/** Extract the first quality token from a title (or null). */
function qualityInTitle(title: string): string | null {
  QUALITY_MARKER.lastIndex = 0;
  const match = QUALITY_MARKER.exec(title);
  QUALITY_MARKER.lastIndex = 0;
  return match ? match[0].toUpperCase() : null;
}

/** Whether a release title signals Chinese subtitles (or the work is natively
 *  Chinese). Extracted from the languageLine rule: a Chinese-community release
 *  name ships 中字 by default; only a pure-English scene release is assumed raw. */
export function signalsChineseSubs(title: string, isChineseNative: boolean): boolean {
  if (isChineseNative) {
    return true; // 国产 — natively Chinese-spoken, no 中字 to hunt
  }
  if (CHINESE_SUB_MARKER.test(title)) {
    return true;
  }
  if (CHINESE_CHAR.test(title)) {
    return true; // Chinese release name → ships 中字 by default
  }
  return false;
}

/** Grade one candidate. Pure function — no side effects, no dead-link store
 *  (known-dead candidates are already filtered out upstream by the provider). */
export function gradeCandidate(
  candidate: GradableCandidate,
  context: GradingContext,
): GradedCandidate {
  const reasons: string[] = [];
  const seasons = seasonNumbersInTitle(candidate.title);
  const hasChineseSub = signalsChineseSubs(candidate.title, context.isChineseNative ?? false);
  const hasEpisodeCode = EPISODE_CODE_MARKER.test(candidate.title);
  const hasComplete = COMPLETE_MARKER.test(candidate.title);
  const quality = qualityInTitle(candidate.title);

  // D — does not even name the target work.
  if (!titleMatches(candidate.title, context)) {
    reasons.push("标题不匹配目标");
    return makeGraded(candidate, "D", reasons, hasChineseSub, seasons, quality);
  }

  // Movie mode (a year is supplied): identity is title + release year, no
  // seasons/episodes. The 同名异作/remake trap is caught by a year mismatch; a
  // year-less release is a legit but unverifiable candidate → B, never auto-killed.
  // The 中字 signal is NOT an A-gate here — the movie fast path is video-only (a
  // 中字/软兜底 order escalates to the LLM agent upstream, never reaches this).
  if (context.year !== undefined) {
    const year = yearInTitle(candidate.title);
    if (context.year <= 0) {
      reasons.push("标题命中，但目标年份未知（无法校验年份）");
      return makeGraded(candidate, "B", reasons, hasChineseSub, seasons, quality);
    }
    if (year !== null && year !== context.year) {
      reasons.push(`年份不符:${year}(目标 ${context.year}),疑似同名异作/remake`);
      return makeGraded(candidate, "C", reasons, hasChineseSub, seasons, quality);
    }
    if (year === context.year) {
      reasons.push("标题命中 + 年份一致");
      return makeGraded(candidate, "A", reasons, hasChineseSub, seasons, quality);
    }
    reasons.push("标题命中，但发行名未带年份（身份存疑）");
    return makeGraded(candidate, "B", reasons, hasChineseSub, seasons, quality);
  }

  // C — names the target but is a DIFFERENT work from the same IP (电影版/真人版…).
  if (DIFFERENT_WORK_MARKER.test(candidate.title)) {
    const match = DIFFERENT_WORK_MARKER.exec(candidate.title)?.[0];
    reasons.push(`疑似同名异作（${match}）`);
    return makeGraded(candidate, "C", reasons, hasChineseSub, seasons, quality);
  }

  // C — the title names a season this task does NOT cover (another season's pack).
  // issue #21:点名单季(含隐形形态 `3.全集`/`3季`)走原 mismatch;季范围(`1-10季`)
  // 也参与降级 —— 范围不含目标季必是别季包;含目标季时范围不给 A 级证据(合集包
  // 内容构成不可信),评分维持原档(中餐厅 1-10 季包今天就是 B,修后仍是 B)。
  const seasonRange = seasonRangeInTitle(candidate.title);
  const seasonMismatch =
    context.seasons.length > 0 &&
    (seasons.length > 0
      ? !seasons.some((season) => context.seasons.includes(season))
      : seasonRange !== null &&
        !context.seasons.some(
          (season) => seasonRange[0] <= season && season <= seasonRange[1],
        ));
  if (seasonMismatch) {
    const named =
      seasons.length > 0
        ? `标题指向季号 ${seasons.join("/")}`
        : seasonRange
          ? `标题季范围 ${seasonRange[0]}-${seasonRange[1]}`
          : "标题季信息";
    reasons.push(`${named}，不在本任务季范围 ${context.seasons.join("/")}`);
    return makeGraded(candidate, "C", reasons, hasChineseSub, seasons, quality);
  }

  // The title names the target work, is not a same-IP different work, and its
  // season (if any) is in scope. Grade on how much identity evidence it carries.
  const seasonScoped = context.seasons.length > 0 && seasons.length > 0;
  const concreteCoverage = hasEpisodeCode || hasComplete || seasonScoped;

  // A — clear identity: 中字 OK (or 国产) AND concrete episode/season/complete
  // evidence. This is the "唯一高分" the fast path can transfer blind.
  if (hasChineseSub && concreteCoverage) {
    reasons.push("标题命中 + 中字 OK + 集数/季数/全集证据明确");
    return makeGraded(candidate, "A", reasons, hasChineseSub, seasons, quality);
  }

  // B — names the target but is missing a detail (no 中字 signal, or no concrete
  // coverage evidence). Still plausible; the arbitrator decides if it's the one.
  if (hasChineseSub) {
    reasons.push("标题命中 + 中字 OK，但缺集数/季数/全集标记（细节存疑）");
  } else {
    reasons.push("标题命中，但无中字信号（疑似生肉/纯英文 scene release）");
  }
  return makeGraded(candidate, "B", reasons, hasChineseSub, seasons, quality);
}

function makeGraded(
  candidate: GradableCandidate,
  grade: CandidateGrade,
  reasons: string[],
  hasChineseSub: boolean,
  seasons: number[],
  quality: string | null,
): GradedCandidate {
  return {
    id: candidate.id,
    title: candidate.title,
    grade,
    score: scoreFor(grade, hasChineseSub, quality, seasons),
    reasons,
    hasChineseSub,
    seasonNumbers: seasons,
    quality,
  };
}

/** Rank key: grade dominates, then 中字, quality presence, and season evidence
 *  break ties within a grade (an A with 中字 + 1080P + season outranks a bare A). */
function scoreFor(
  grade: CandidateGrade,
  hasChineseSub: boolean,
  quality: string | null,
  seasons: number[],
): number {
  const base = grade === "A" ? 400 : grade === "B" ? 300 : grade === "C" ? 200 : 100;
  return base + (hasChineseSub ? 40 : 0) + (quality ? 20 : 0) + (seasons.length > 0 ? 10 : 0);
}

const GRADE_ORDER: Record<CandidateGrade, number> = { A: 0, B: 1, C: 2, D: 3 };

/** Grade every candidate and rank them best-first. */
export function gradeCandidates(
  candidates: readonly GradableCandidate[],
  context: GradingContext,
): GradingResult {
  const graded = candidates.map((candidate) => gradeCandidate(candidate, context));
  graded.sort(
    (a, b) => GRADE_ORDER[a.grade] - GRADE_ORDER[b.grade] || b.score - a.score,
  );
  return {
    ranked: graded,
    uniqueTopGrade: graded.length > 0 && graded[0]!.grade === "A",
    top: graded[0] ?? null,
  };
}

/** A compact, LLM-ready summary of the ranked candidates (the arbitrator's input
 *  when the rules cannot decide). Omits the dead-weight D-grade tail.
 *
 *  Each line carries the candidate's real id in its OWN bracket — `[A] [<id>]
 *  <title> — <reasons>` — so the arbitrator can copy `[id]` verbatim into
 *  candidateId. Without it the model only sees titles and fills the title back
 *  as the id (the SANDBOX_CANDIDATE_NOT_IN_SNAPSHOT 狂飙 incident). */
export function summarizeGrading(result: GradingResult, maxLines = 30): string {
  const lines: string[] = [];
  for (const g of result.ranked) {
    if (g.grade === "D" && lines.length > 0) {
      // Stop at the first D once we've listed anything — D grades are pure noise.
      break;
    }
    lines.push(`[${g.grade}] [${g.id}] ${g.title} — ${g.reasons.join("; ") || "—"}`);
    if (lines.length >= maxLines) break;
  }
  return lines.join("\n") || "(无候选)";
}
