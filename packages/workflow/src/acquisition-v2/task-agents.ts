/**
 * 保留此文件仅为向后兼容:task-agents.ts 曾是 fast path / orchestrator 的主要消费方，
 * 2026-09-02 issue #34 将 target 类型和 need 计算迁出到 target-types.ts，
 * 同时删掉旧 agent 环路(runTvAnimeTaskAgent/runMovieTaskAgent)和所有 prompt 构建器。
 * 此文件现在只是一个 re-export shim——未来若所有消费者改走 target-types，可直接删除。
 */

export { needForMovie, needForTvTarget, type MovieTarget, type TvAnimeTarget } from "./target-types.js";