import { canonicalEpisodeFileName, episodeCodeFromFileName } from "../episode-code.js";
import { TaskSandbox } from "./sandbox.js";
import type { SimTreeFile } from "./storage-115-simulator.js";
import type { MovieStagingDigest, StagingDigest } from "./staging-digest.js";

/**
 * Finalize-landing for the fast path (zero-LLM): after the staging digest says a
 * landing CLEANLY covers the need, this module runs the same three-step close-out
 * the agent used to drive by hand — rename videos to canonical names, 归位 files
 * into their season directories, and mark the episodes obtained — then wipes the
 * staging dir. No LLM round-trip. It reuses the sandbox's own guarded methods
 * (renameVideo / moveToSeason / markObtained / discardStaging) so every existing
 * scope guard, shape contract, and coverage bookkeeping stays in force.
 */

export interface FinalizeLandingOptions {
  sandbox: TaskSandbox;
  digest: StagingDigest;
  /** Canonical title for `Title.SxxExx.ext` (the scraper matches the season
   *  DIRECTORY, so the prefix is our canonical title — see sandbox renameVideo). */
  canonicalTitle: string;
  /** The task's target seasons (drives 归位 grouping). */
  seasons: number[];
  /** AI 集数映射(§2.2)的 fileName→code 覆盖表。代码解析不出的 fansub/纯数字
   *  文件名由映射仲裁给出 code 后,rename 与归位也必须用它 —— 否则 finalize 用
   *  裸文件名重新解析(AI 映射的文件名原规则解析不出)会跳过这些文件,导致
   *  renamed 空 → 空洞校验把 mark 也挡掉,映射的成果完全落不了地。 */
  overrides?: Record<string, string>;
}

export interface FinalizeLandingResult {
  /** Canonical names actually renamed. */
  renamed: string[];
  /** season -> count of files moved into it. */
  movedSeasons: Record<number, number>;
  /** Episode codes marked obtained (in-scope parsed codes, incl. provider-ahead). */
  marked: string[];
  /** Files removed by the staging wipe. */
  discarded: string[];
}

/** Season number of an episode code ("S01E13" → 1), or null. */
export function seasonFromEpisodeCode(code: string): number | null {
  const match = /^S(\d{1,2})E/.exec(code);
  return match ? Number(match[1]) : null;
}

function fileBaseName(path: string): string {
  return path.split("/").pop() ?? path;
}

/** Step log with the same `[mediary-run][runId] title | step: detail` shape the
 *  fast path uses — so the finalize-landing rename trace is indistinguishable in
 *  the fnOS app log. Not credentials/links, only filenames. */
function stepLog(sandbox: TaskSandbox, title: string, step: string, detail: string): void {
  console.log(`[mediary-run][${sandbox.logRunId}] ${title} | ${step}: ${detail}`);
}

/** Group every in-scope video (and its subtitles) into per-season move batches.
 *  Videos move by their parsed episode code's season; a subtitle rides with its
 *  video when it parses to the same season, else stays in staging.
 *  `overrides`(AI 集数映射)优先于裸文件名解析。 */
export function buildSeasonMoves(
  digest: StagingDigest,
  seasons: number[],
  overrides?: Record<string, string>,
): Array<{ season: number; fileIds: string[] }> {
  const seasonSet = new Set(seasons);
  const junkNames = new Set(digest.junkSignals);
  const bySeason = new Map<number, string[]>();
  const overridesTable = overrides ?? {};
  const push = (season: number, fileId: string) => {
    const list = bySeason.get(season) ?? [];
    list.push(fileId);
    bySeason.set(season, list);
  };

  for (const video of digest.videos) {
    if (junkNames.has(fileBaseName(video.path))) continue;
    const code = overridesTable[fileBaseName(video.path)] ?? episodeCodeFromFileName(fileBaseName(video.path));
    if (!code) continue;
    const season = seasonFromEpisodeCode(code);
    if (season === null || !seasonSet.has(season)) continue;
    push(season, video.id);
  }
  for (const subtitle of digest.subtitles) {
    if (junkNames.has(fileBaseName(subtitle.path))) continue;
    const code = overridesTable[fileBaseName(subtitle.path)] ?? episodeCodeFromFileName(fileBaseName(subtitle.path));
    if (code) {
      const season = seasonFromEpisodeCode(code);
      if (season !== null && seasonSet.has(season)) {
        push(season, subtitle.id);
      }
    }
  }

  return [...bySeason.entries()].map(([season, fileIds]) => ({ season, fileIds }));
}

/** Rename, 归位, mark, and wipe — the fast path's mechanical close-out. */
export async function finalizeLanding(
  options: FinalizeLandingOptions,
): Promise<FinalizeLandingResult> {
  const { sandbox, digest, canonicalTitle, seasons, overrides } = options;
  const seasonSet = new Set(seasons);
  const overridesTable = overrides ?? {};

  // 1. Rename every in-scope video to `Title.SxxExx.ext`. canonicalEpisodeFileName
  //    carries the extension over so the file stays playable. Junk files (sample/
  //    广告/花絮) are skipped — they stay in staging for the wipe, never renamed.
  //    Code source: AI 映射(§2.2)的 overrides 优先(代码解析不出的 fansub/纯数字
  //    文件名由仲裁给出 code),否则用裸文件名解析。
  const renames: Array<{ fileId: string; newName: string }> = [];
  const renamed: string[] = [];
  const junkNames = new Set(digest.junkSignals);
  for (const video of digest.videos) {
    const base = fileBaseName(video.path);
    if (junkNames.has(base)) continue;
    const code = overridesTable[base] ?? episodeCodeFromFileName(base);
    if (!code) continue;
    const season = seasonFromEpisodeCode(code);
    if (season === null || !seasonSet.has(season)) continue;
    const newName = canonicalEpisodeFileName({ title: canonicalTitle, episodeCode: code, sourceName: base });
    renames.push({ fileId: video.id, newName });
  }
  if (renames.length > 0) {
    const result = await sandbox.renameVideo({ renames });
    renamed.push(...result.renamed);
    // 原名 → 网盘文件名 一一对应：每次真实转存落盘后的规范化改名都留痕。失败项也列出,
    // 让用户能看到哪个文件没改成功。
    const baseById = new Map(digest.videos.map((video) => [video.id, fileBaseName(video.path)]));
    const errorByFileId = new Map((result.errors ?? []).map((e) => [e.fileId, e.error]));
    for (const { fileId, newName } of renames) {
      const source = baseById.get(fileId) ?? fileId;
      const err = errorByFileId.get(fileId);
      if (err === undefined) {
        stepLog(sandbox, canonicalTitle, "改名", `${source} → ${newName}`);
      } else {
        stepLog(sandbox, canonicalTitle, "改名失败", `${source} → ${newName} (${err})`);
      }
    }
  }

  // 2. 归位 into season directories (subtitles ride with their videos).
  //    overrides 同样优先 —— 否则 fansub 名(如 `[NC-Raws] 狂飙 - 01.mkv`)虽然
  //    rename 成功为 `狂飙.S01E01.mkv`,归位又按裸名解析会跳过,文件留在 staging 被清。
  const moves = buildSeasonMoves(digest, seasons, overridesTable);
  const movedSeasons: Record<number, number> = {};
  if (moves.length > 0) {
    const result = await sandbox.moveToSeason({ moves });
    for (const [season, files] of Object.entries(result.seasons)) {
      movedSeasons[Number(season)] = files.length;
    }
  }

  // 3. Mark every in-scope parsed code obtained — a full pack often lands episodes
  //    BEYOND the need (provider-ahead), and those must survive finish() so
  //    syncSeasonNeed records them, not just the aired cursor (live #4 bug).
  //
  //    2026-08-19 空洞校验:mark 的依据必须是「本文件名真的解析出的在季代码」,
  //    而不是 digest 里 LLM 可能脑补出来的东西。仲裁 accept 后 digest 的
  //    episodeCodes 可能包含「AI 说这是 S01E04 但文件根本不在」的幻觉 —— 步骤 1
  //    只对真实存在的文件改名,所以 renamed 是 ground truth。若 renamed 为空(一个
  //    文件都没按 SxxExx 改名成功),就绝不允许 mark 任何代码 — 宁可报
  //    no-coverage,也不能在 staging 里什么都没落地时记 obtained(曾线上踩过:
  //    accept 空洞 → mark 假入库 → syncSeasonNeed 把没下到的集数写成已拿到)。
  const renamedToCodes = renamed
    .map((name) => {
      const base = fileBaseName(name);
      const code = episodeCodeFromFileName(base);
      return code ?? null;
    })
    .filter((code): code is string => code !== null);
  const renamedCodeSet = new Set(renamedToCodes);
  // 原逻辑保留:digest 里的在季代码(rename 前解析),与 renamed 交集后才可信。
  const inScopeCodes = digest.episodeCodes.filter((code) => {
    const season = seasonFromEpisodeCode(code);
    return season !== null && seasonSet.has(season);
  });
  const marine = inScopeCodes.filter((code) => renamedCodeSet.has(code));

  const marked = marine.length > 0
    ? (await sandbox.markObtained({ codes: marine })).confirmed
    : [];

  // 4. Wipe staging (leftovers: out-of-scope episodes, dup packs, residue).
  const discarded = (await sandbox.discardStaging()).removed;

  return { renamed, movedSeasons, marked, discarded };
}

/**
 * Movie finalize-landing for the fast path (zero-LLM): after the movie staging
 * digest confirms ONE film landed, this runs the same close-out the agent used to
 * drive by hand — flatten (move the film + subtitles up, auto-rename to
 * `Title (Year).ext`, strip the wrapper) and mark the MOVIE obtained. No
 * discardStaging: a movie's staging IS its movie dir (flatten in place, §5), so
 * there is nothing to wipe — the flatten already peeled the wrapper.
 *
 * When a dirty landing was ACCEPTED by the diagnostic arbitrator (film + a
 * trailer / 花絮 bundled), the extra videos are dropped first — the film is the
 * largest video, everything else is a wrapper remnant, never the film.
 */

export interface FinalizeMovieLandingOptions {
  sandbox: TaskSandbox;
  digest: MovieStagingDigest;
}

export interface FinalizeMovieLandingResult {
  /** The flattened (canonical-named) movie dir contents after flatten. */
  movie: SimTreeFile[];
  /** The obtained tokens (always ["MOVIE"]). */
  marked: string[];
}

export async function finalizeMovieLanding(
  options: FinalizeMovieLandingOptions,
): Promise<FinalizeMovieLandingResult> {
  const { sandbox, digest } = options;

  // A clean landing holds exactly one video; an accepted dirty landing may carry
  // extras (trailers/花絮/sample). The film is the LARGEST video — drop the rest
  // before flattening so flattenMovie renames only the film (two same-named
  // canonical renames would collide).
  if (digest.videos.length > 1) {
    const bySize = [...digest.videos].sort((a, b) => b.sizeBytes - a.sizeBytes);
    const extras = bySize.slice(1).map((file) => file.id);
    await sandbox.deleteFiles({ directory: "staging", fileIds: extras });
  }

  // flattenMovie auto-renames the film + subtitles to `Title (Year).ext` and
  // removes the wrapper subdirs (staging === movie dir, so no discardStaging).
  const { movie } = await sandbox.flattenMovie();
  const marked = (await sandbox.markObtained({ codes: ["MOVIE"] })).confirmed;

  return { movie, marked };
}

