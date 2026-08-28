/**
 * ★ 任务消费流水线 · 步骤⑤：fast path 本体已按 design §5/§7 拆入
 *   consumption/fast-path/{budgets,steps,landing,tv,movie}.ts —— 本文件退居
 *   兼容壳，保留全部历史出口名（orchestrator 与 fast-path/movie-fast-path 测试
 *   的引用面零改动）。日志文案、预算语义、LandingVerdict 七值判定全部同源。
 */
export type { FastPathOptions, FastPathResult } from "../consumption/fast-path/steps.js";
export { runFastPathAcquisition } from "../consumption/fast-path/tv.js";
export type {
  MovieFastPathOptions,
  MovieFastPathResult,
} from "../consumption/fast-path/movie.js";
export { runMovieFastPathAcquisition } from "../consumption/fast-path/movie.js";
