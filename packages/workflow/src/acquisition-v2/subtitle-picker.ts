/**
 * Deterministic subtitle picker for the movie fast path (zero-LLM 中字选择).
 *
 * The old movie route handed "pick an assrt package" to the LLM agent because
 * it is a judgment call: language coverage, community vote, 字幕组 reputation,
 * freshness. That call is real, but for the FAST PATH we can approximate it
 * with a small mechanical policy — and the approximation is good enough for the
 * default case (land the most-voted package whose language tag matches the
 * user's preference; fall back through the list deterministically).
 *
 * Policy (checked in order, first match wins):
 *   1. Prefer the package whose language tag COVERS the user's preferred
 *      language. The tag is a space-joined set like "英 简 双语" / "简 繁" —
 *      "简" (simplified Chinese) vs "繁" (traditional) are both a 中字 match;
 *      "双语" (dual) also covers. We do NOT parse per-language semantics: any
 *      tag token that equals the preference, or contains "中"/"简"/"繁"/"双语",
 *      is a 中字 hit. Unknown/empty tags are a WEAK match (never preferred over
 *      an explicit match, but never auto-rejected either).
 *   2. Within the matched group, score by voteScore (★) — community signal.
 *   3. Tie-break: known-good 字幕组 whitelist, then newer uploadTime.
 *
 * The picker is PURE — no sandbox, no provider, no side effects — so it is
 * trivially unit-testable and safe to run in the fast path.
 */

import type { AssrtCandidate } from "../subtitle-provider.js";

export interface SubtitlePickPolicy {
  /** The user's subtitle preference string, e.g. "简体中文". Empty = no preference. */
  preferredLanguage: string;
}

/** A picked subtitle candidate, or null when there is nothing to land. */
export type SubtitlePick =
  | { picked: AssrtCandidate; reason: string }
  | { picked: null; reason: string };

/** Chinese-sub language tokens we recognize as "this package carriers 中字". */
const ZH_SUB_TOKENS = /中|简|繁|双|国语|chinese|chs|cht|sc|tc/i;

/** 字幕组口碑白名单 — community-validated groups, tie-break bonus. */
const KNOWN_GROUPS = new Set([
  "字幕侠",
  "人人影视",
  "YYeTs",
  "Fix字幕侠",
  "SubHD",
  "zimuku",
  "assrt",
]);

/** Does this package's language tag signal Chinese subtitles? */
export function hasChineseSubtitle(candidate: AssrtCandidate): boolean {
  return ZH_SUB_TOKENS.test(candidate.lang ?? "");
}

/** Does the package explicitly match the user's preferred language? */
export function matchesPreference(candidate: AssrtCandidate, preference: string): boolean {
  const pref = preference.trim().toLowerCase();
  if (!pref) {
    return true; // no preference → everything is "matching"
  }
  const lang = (candidate.lang ?? "").toLowerCase();
  if (!lang) {
    return false; // unknown tag cannot confirm the preference
  }
  // Exact token match ("简" in "英 简 双语").
  const tokens = lang.split(/\s+/);
  if (tokens.some((tok) => tok === pref)) {
    return true;
  }
  // Fuzzy: preference "简体" / "简中" / "chinese" should hit a "简" tag.
  return (
    lang.includes(pref) ||
    pref.includes(lang.trim()) ||
    (pref.includes("简") && lang.includes("简")) ||
    (pref.includes("繁") && lang.includes("繁")) ||
    /chinese/.test(pref) && /chinese|中|简|繁/.test(lang)
  );
}

/** Deterministically pick ONE subtitle package from the snapshot. */
export function pickSubtitle(
  candidates: readonly AssrtCandidate[],
  policy: SubtitlePickPolicy,
): SubtitlePick {
  if (candidates.length === 0) {
    return { picked: null, reason: "无字幕候选（assrt 快照为空）" };
  }

  const exact = candidates.filter((c) => matchesPreference(c, policy.preferredLanguage));
  const pool = exact.length > 0 ? exact : candidates;

  const scored = pool
    .map((candidate) => {
      const matched = exact.includes(candidate);
      let score = 0;
      if (matched) score += 100; // explicit language-preference match dominates
      score += (candidate.voteScore ?? 0) * 10; // ★ community signal
      if (KNOWN_GROUPS.has(candidate.releaseSite ?? "")) score += 50; // 口碑组加成
      return { candidate, score, matched };
    })
    .sort((a, b) => b.score - a.score || b.candidate.voteScore! - a.candidate.voteScore! || 0);

  const best = scored[0]!;
  const reason = `字幕选择:${best.candidate.title} (lang=${best.candidate.lang ?? "-"} ★=${best.candidate.voteScore ?? "-"} 组=${best.candidate.releaseSite ?? "-"}) ${
    best.matched ? "命中语言偏好" : "语言偏好无精确命中,按★/口碑回落"
  }`;
  return { picked: best.candidate, reason };
}