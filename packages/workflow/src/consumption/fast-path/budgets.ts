/**
 * fast path 硬预算（design §5 consumption/fast-path/budgets.ts；语义红线）：
 *   - 转存预算 3：**primary 池**每 run 真实转存上限（先试 primary 的 A 候选）；
 *   - 兜底转存预算 3：**兜底池**独立转存上限（primary 无 A 或试尽后才启动兜底重搜，
 *     搜到的新候选用自己的预算，不与 primary 互相挤占 —— primary 3 次全废兜底仍能转）；
 *   - 死链探测 10：不占任何转存预算（狂飙 45 候选教训）；
 *   - 别名兜底重搜 3：保护共享 PanSou 配额。
 * Budgets 接口把四个上限显式化为可注入对象（design §5）；当前两个业务循环仍直读
 * 常量（值同源），注入化收口在认领侧重构完成后按需接入 —— 行为零变化优先。
 */
/** Hard ceiling on transfer attempts per fast-path run for the PRIMARY pool. */
export const MAX_TRANSFER_ATTEMPTS = 3;

/** Hard ceiling on transfer attempts for the ALIASES 兜底 pool only. Primary and
 *  fallback budgets are independent: the primary pool can exhaust all 3 attempts
 *  and the fallback pool still gets its own budget to keep searching/trying —
 *  a primary pool full of off-target packs must not starve the aliases' hits. */
export const MAX_FALLBACK_TRANSFER_ATTEMPTS = 3;

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
  maxDeadLinkRetries: number;
  maxFallbackSearches: number;
}

export const DEFAULT_BUDGETS: Budgets = {
  maxTransferAttempts: MAX_TRANSFER_ATTEMPTS,
  maxFallbackTransferAttempts: MAX_FALLBACK_TRANSFER_ATTEMPTS,
  maxDeadLinkRetries: MAX_DEAD_LINK_RETRIES,
  maxFallbackSearches: MAX_FALLBACK_SEARCHES,
};
