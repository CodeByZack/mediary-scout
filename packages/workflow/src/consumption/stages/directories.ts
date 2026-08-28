import type { StorageExecutor } from "../../ports.js";
import {
  ensureSeasonAcquisitionDirectories,
  type AcquisitionDirectories,
} from "../../acquisition-v2/directory-lifecycle.js";
import { withStagingCleanup } from "../../acquisition-v2/directory-lifecycle.js";
import { readLandedSize } from "../../acquisition-v2/landed-size.js";

/**
 * 七阶段之 ①prepareDirectories / ②withStagingCleanup / ⑥readLandedSize
 * （design §2、§7 consumption/stages/directories.ts）。
 *
 * 器件（directory-lifecycle.ts、landed-size.ts）不动 —— 本文件只是把
 * acquisition-v2/workflow-v2.ts 里的装配段升格为按阶段命名的收口点。
 * 实现逐字等价于今天的 7a 段：verify-or-create Show/Season/staging 目录树，
 * anime 的落点父级已在上游（①父级选择）与器件内处理。
 */
export interface PrepareDirectoriesInput {
  executor: StorageExecutor;
  /** 已按 kind/媒体类型选定的库分类父目录（Movies/TV/Anime）。 */
  categoryParentId: string;
  showName: string;
  year: number;
  tmdbId: number;
  seasons: number[];
  workflowRunId: string;
}

export function prepareDirectories(
  input: PrepareDirectoriesInput,
): Promise<AcquisitionDirectories> {
  return ensureSeasonAcquisitionDirectories(input);
}

/**
 * ② 兜底清理：包住 ③–⑥ —— 无论覆盖/失败/reportNoCoverage，run 的 staging 目录
 * 必删（斗破苍穹 335 文件泄漏修复）。agent 自己的 discardStaging 照常，这里是
 * 确定性 backstop（withStagingCleanup 幂等，双保险无冲突）。
 */
export function withStagingCleanupStage<T>(
  input: { executor: StorageExecutor; stagingDirectoryId: string },
  run: () => Promise<T>,
): Promise<T> {
  return withStagingCleanup(input, run);
}

/**
 * ⑥ 通知用真实体积（best-effort）：跑成功后读季目录里的真实落盘文件；115 调用
 * 预算耗尽/读失败只省略体积，绝不让好 run 失败。原注释语义逐字保留：
 * Best-effort real landed size for the notification (true per-episode bytes,
 * not a claimed quality).
 */
export interface LandedSize {
  fileCount: number;
  totalBytes: number;
}

export function readLandedSizeStage(
  executor: StorageExecutor,
  seasonDirectoryIds: Record<number, string>,
): Promise<LandedSize | undefined> {
  return readLandedSize(executor, Object.values(seasonDirectoryIds));
}
