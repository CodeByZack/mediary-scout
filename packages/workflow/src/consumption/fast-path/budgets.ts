/**
 * fast path 硬预算（design §5 consumption/fast-path/budgets.ts；语义红线）：
 *   - 转存预算 10：**primary 池**代码路径（评分器走）每 run 真实转存上限；
 *   - AI 子预算 3：primary 池 AI 挑选路径的转存上限（独立于代码池，不互相挤占）；
 *   - 兜底转存预算 5：**兜底池**代码路径独立转存上限；
 *   - 兜底 AI 子预算 1：兜底池 AI 挑选路径的转存上限；
 *   - 尾部重转 3：两池耗尽后，按覆盖数降序重转最优候选的上限（分享过期轮换）；
 *   - 死链探测 10：不占任何转存预算（狂飙 45 候选教训）；
 *   - 别名兜底重搜 3：保护共享 PanSou 配额。
 * Budgets 接口把上限显式化为可注入对象（design §5）；当前两个业务循环仍直读
 * 常量（值同源），注入化收口在认领侧重构完成后按需接入 —— 行为零变化优先。
 */
/** Hard ceiling on transfer attempts per fast-path run for the PRIMARY pool
 *  code path (grader-ranked candidates walked by nextCandidate). */
export const MAX_TRANSFER_ATTEMPTS = 10;

/** Hard ceiling on AI-picked candidate transfers for the PRIMARY pool.
 *  Independent sub-budget: AI picks do NOT consume the code-path pool budget. */
export const MAX_AI_PICKS_PRIMARY = 3;

/** Hard ceiling on transfer attempts for the ALIASES 兜底 pool code path.
 *  Primary and fallback budgets are independent: a primary pool full of
 *  off-target packs must not starve the aliases' hits. */
export const MAX_FALLBACK_TRANSFER_ATTEMPTS = 5;

/** Hard ceiling on AI-picked candidate transfers for the 兜底 pool. */
export const MAX_AI_PICKS_FALLBACK = 1;

/** Hard ceiling on tail re-transfer attempts: after both pools exhaust with no
 *  full coverage, the best partial-coverage candidate(s) are re-transferred.
 *  Top-3 rotation guards against share expiry between evaluation and tail. */
export const MAX_TAIL_RETRANSFER = 3;

/** Dead-link retries must NOT consume the transfer-attempt budget: a dead share
 *  fails loud (分享已过期/已取消/不存在) at the share-check step WITHOUT any real
 *  transfer action (no 秒传/复制), so it is a cheap probe. Cap the dead-link
 *  scan separately so a candidate pool full of dead shares still gets scanned
 *  for a live one (狂飙 45 候选只试 3 个死链就放弃的教训). */
export const MAX_DEAD_LINK_RETRIES = 10;

/** Hard ceiling on ALIASES 兜底重搜 rounds per fast-path run. The primary search
 *  already ran; each fallback round is one more PanSou hit, so cap it hard (≤3)
 *  to keep a title that fails to recall from hammering the shared quota. */
export const MAX_FALLBACK_SEARCHES = 3;

export interface Budgets {
  maxTransferAttempts: number;
  maxFallbackTransferAttempts: number;
  maxAiPicksPrimary: number;
  maxAiPicksFallback: number;
  maxTailRetransfer: number;
  maxDeadLinkRetries: number;
  maxFallbackSearches: number;
}

export const DEFAULT_BUDGETS: Budgets = {
  maxTransferAttempts: MAX_TRANSFER_ATTEMPTS,
  maxFallbackTransferAttempts: MAX_FALLBACK_TRANSFER_ATTEMPTS,
  maxAiPicksPrimary: MAX_AI_PICKS_PRIMARY,
  maxAiPicksFallback: MAX_AI_PICKS_FALLBACK,
  maxTailRetransfer: MAX_TAIL_RETRANSFER,
  maxDeadLinkRetries: MAX_DEAD_LINK_RETRIES,
  maxFallbackSearches: MAX_FALLBACK_SEARCHES,
};
