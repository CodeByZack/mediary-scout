import { describe, expect, it } from "vitest";
import { TaskSandbox } from "../src/acquisition-v2/sandbox.js";
import { FakeResourceProviderV2 } from "../src/acquisition-v2/fake-provider.js";
import { Storage115Simulator } from "../src/acquisition-v2/storage-115-simulator.js";
import { digestMovieStaging, digestStaging } from "../src/acquisition-v2/staging-digest.js";
import {
  buildSeasonMoves,
  finalizeLanding,
  finalizeMovieLanding,
  seasonFromEpisodeCode,
} from "../src/acquisition-v2/finalize-landing.js";

async function createSandbox(need = ["S01E01", "S01E02"]) {
  const provider = new FakeResourceProviderV2({ results: {} });
  const storage = new Storage115Simulator({ packs: {} });
  const stagingDirectoryId = await storage.createDirectory({ name: "staging", parentId: "root" });
  const s1 = await storage.createDirectory({ name: "Season 1", parentId: "root" });
  const s2 = await storage.createDirectory({ name: "Season 2", parentId: "root" });
  const sandbox = new TaskSandbox({
    provider,
    storage,
    stagingDirectoryId,
    targetSeasonDirectoryIds: { 1: s1, 2: s2 },
    need,
    canonicalTitle: "狂飙",
  });
  return { sandbox, storage, stagingDirectoryId, s1, s2 };
}

async function landFile(storage: Storage115Simulator, stagingDirectoryId: string, filename: string) {
  const [id] = (await storage.transferSubtitleUrl({
    url: "http://x/file",
    filename,
    intoDirectoryId: stagingDirectoryId,
  })).materializedFileIds;
  return id!;
}

describe("seasonFromEpisodeCode", () => {
  it("reads the season from SxxExx", () => {
    expect(seasonFromEpisodeCode("S01E13")).toBe(1);
    expect(seasonFromEpisodeCode("S12E01")).toBe(12);
    expect(seasonFromEpisodeCode("MOVIE")).toBeNull();
  });
});

describe("buildSeasonMoves", () => {
  it("groups videos and their subtitles by season", () => {
    const files = [
      { id: "v1", path: "Show.S01E01.mkv", sizeBytes: 1, isVideo: true, isSubtitle: false },
      { id: "v2", path: "Show.S02E01.mkv", sizeBytes: 1, isVideo: true, isSubtitle: false },
      { id: "s1", path: "Show.S01E01.zh.ass", sizeBytes: 1, isVideo: false, isSubtitle: true },
    ];
    const digest = digestStaging({ files, seasons: [1, 2], needCodes: ["S01E01", "S02E01"] });
    const moves = buildSeasonMoves(digest, [1, 2]);
    const bySeason = Object.fromEntries(moves.map((m) => [m.season!, m.fileIds]));
    expect(bySeason[1]).toEqual(["v1", "s1"]);
    expect(bySeason[2]).toEqual(["v2"]);
  });

  it("uses overrides (AI 集数映射) for files the code cannot parse", () => {
    const files = [
      { id: "v1", path: "[NC-Raws] 狂飙 - 01.mkv", sizeBytes: 1, isVideo: true, isSubtitle: false },
      { id: "v2", path: "Sub.S01E01.zh.ass", sizeBytes: 1, isVideo: false, isSubtitle: true },
    ];
    const digest = digestStaging({ files, seasons: [1], needCodes: ["S01E01"] });
    // 无 overrides: v1 解析不出 code → 不归位;字幕自己能解析 → 单独归位。
    const movesWithout = buildSeasonMoves(digest, [1]);
    const bySeasonWithout = Object.fromEntries(movesWithout.map((m) => [m.season!, m.fileIds]));
    expect(bySeasonWithout[1]).toEqual(["v2"]);
    // 有 overrides: v1 映射为 S01E01 → 归位到 season 1,字幕一起。
    const moves = buildSeasonMoves(digest, [1], { "[NC-Raws] 狂飙 - 01.mkv": "S01E01" });
    const bySeason = Object.fromEntries(moves.map((m) => [m.season!, m.fileIds]));
    expect(bySeason[1]).toEqual(["v1", "v2"]);
  });
});

describe("finalizeLanding", () => {
  it("renames, 归位, marks, and wipes staging in one pass", async () => {
    const { sandbox, storage, stagingDirectoryId, s1 } = await createSandbox();
    await landFile(storage, stagingDirectoryId, "狂飙.S01E01.1080p.mkv");
    await landFile(storage, stagingDirectoryId, "狂飙.S01E02.1080p.mkv");
    await landFile(storage, stagingDirectoryId, "狂飙.S01E01.zh.ass");

    const digest = digestStaging({
      files: await sandbox.inspectStaging(),
      seasons: [1],
      needCodes: ["S01E01", "S01E02"],
    });
    expect(digest.passes).toBe(true);

    const result = await finalizeLanding({ sandbox, digest, canonicalTitle: "狂飙", seasons: [1] });

    expect(result.renamed).toEqual(["狂飙.S01E01.mkv", "狂飙.S01E02.mkv"]);
    expect(result.marked).toEqual(["S01E01", "S01E02"]);
    expect(result.movedSeasons[1]).toBe(3); // 2 videos + 1 subtitle

    // staging dir itself was removed (not merely emptied); the season dir holds
    // the canonical names.
    await expect(storage.listTree({ directoryId: stagingDirectoryId })).rejects.toThrow(/SIM_DIR_NOT_FOUND/);
    const season1 = await storage.listTree({ directoryId: s1 });
    expect(season1.map((f) => f.path).sort()).toEqual([
      "狂飙.S01E01.mkv",
      "狂飙.S01E01.zh.ass",
      "狂飙.S01E02.mkv",
    ]);
    expect((await sandbox.finish()).coverageMet).toBe(true);
  });

  it("marks provider-ahead episodes beyond the need", async () => {
    const { sandbox, storage, stagingDirectoryId } = await createSandbox(["S01E01"]);
    await landFile(storage, stagingDirectoryId, "狂飙.S01E01.mkv");
    await landFile(storage, stagingDirectoryId, "狂飙.S01E02.mkv");
    await landFile(storage, stagingDirectoryId, "狂飙.S01E03.mkv");

    const digest = digestStaging({
      files: await sandbox.inspectStaging(),
      seasons: [1],
      needCodes: ["S01E01"],
    });
    const result = await finalizeLanding({ sandbox, digest, canonicalTitle: "狂飙", seasons: [1] });

    // A full pack lands episodes past the aired cursor; all must survive finish().
    expect(result.marked).toEqual(["S01E01", "S01E02", "S01E03"]);
  });

  it("leaves out-of-scope files unrenamed/未标记 but wipes them as residue", async () => {
    const { sandbox, storage, stagingDirectoryId, s1, s2 } = await createSandbox(["S01E01"]);
    await landFile(storage, stagingDirectoryId, "狂飙.S01E01.mkv");
    await landFile(storage, stagingDirectoryId, "狂飙.S02E01.mkv"); // out of scope

    const digest = digestStaging({
      files: await sandbox.inspectStaging(),
      seasons: [1],
      needCodes: ["S01E01"],
    });
    const result = await finalizeLanding({ sandbox, digest, canonicalTitle: "狂飙", seasons: [1] });

    expect(result.renamed).toEqual(["狂飙.S01E01.mkv"]);
    expect(result.marked).toEqual(["S01E01"]);
    // staging fully wiped (the S02 leftover is discarded, not moved anywhere).
    await expect(storage.listTree({ directoryId: stagingDirectoryId })).rejects.toThrow(/SIM_DIR_NOT_FOUND/);
    expect(await storage.listTree({ directoryId: s2 })).toEqual([]);
  });
});

describe("finalizeMovieLanding", () => {
  /** Movie sandbox: staging === movie dir (flatten in place, §5). */
  async function createMovieSandbox(packs: Record<string, { files: Array<{ path: string; sizeBytes: number }> }>) {
    const provider = new FakeResourceProviderV2({ results: {} });
    const storage = new Storage115Simulator({ packs });
    const movieDir = await storage.createDirectory({ name: "流浪地球 (2019)", parentId: "root" });
    const sandbox = new TaskSandbox({
      provider,
      storage,
      stagingDirectoryId: movieDir,
      targetMovieDirectoryId: movieDir,
      need: ["MOVIE"],
      canonicalTitle: "流浪地球",
      canonicalYear: 2019,
      titleTerms: ["流浪地球"],
    });
    return { sandbox, storage, movieDir };
  }

  it("flattens + canonical-renames the film and marks MOVIE (no discardStaging)", async () => {
    const { sandbox, storage, movieDir } = await createMovieSandbox({
      p1: { files: [{ path: "包/流浪地球.2019.4K.mkv", sizeBytes: 2_000_000_000 }] },
    });
    await storage.transferCandidate({ candidateId: "p1", intoDirectoryId: movieDir });

    const digest = digestMovieStaging(await sandbox.inspectStaging());
    expect(digest.passes).toBe(true);

    const result = await finalizeMovieLanding({ sandbox, digest });

    expect(result.marked).toEqual(["MOVIE"]);
    // The wrapper dir is peeled, the film canonical-renamed at the movie dir root.
    expect((await storage.listTree({ directoryId: movieDir })).map((f) => f.path)).toEqual([
      "流浪地球 (2019).mkv",
    ]);
    expect((await sandbox.finish()).coverageMet).toBe(true);
  });

  it("an accepted dirty landing drops every video except the LARGEST (the film) before flatten", async () => {
    const { sandbox, storage, movieDir } = await createMovieSandbox({
      p1: {
        files: [
          { path: "包/流浪地球.预告.mkv", sizeBytes: 100_000_000 },
          { path: "包/流浪地球.2019.4K.mkv", sizeBytes: 2_000_000_000 },
        ],
      },
    });
    await storage.transferCandidate({ candidateId: "p1", intoDirectoryId: movieDir });

    const digest = digestMovieStaging(await sandbox.inspectStaging());
    expect(digest.passes).toBe(false);
    expect(digest.isDirtyPack).toBe(true);

    const result = await finalizeMovieLanding({ sandbox, digest });

    expect(result.marked).toEqual(["MOVIE"]);
    // The trailer (smallest video) is dropped; only the film survives, renamed.
    expect((await storage.listTree({ directoryId: movieDir })).map((f) => f.path)).toEqual([
      "流浪地球 (2019).mkv",
    ]);
  });
});
it("功能3+功能2: overrides 喂给 finalize 后 rename 能落地,mark 以真实改名结果为准", async () => {
    // 落盘 `狂飙 - 01.mkv`:digest 通过 overrides(AI 集数映射)认为它是 S01E01,
    // 且 finalize 也收到同一份 overrides → rename 用映射 code 改成 `狂飙.S01E01.mkv`
    // → renamed 非空 → mark S01E01(不是空洞,文件真的规整落位)。
    const { sandbox, storage, stagingDirectoryId, s1 } = await createSandbox(["S01E01", "S01E02"]);
    await landFile(storage, stagingDirectoryId, "狂飙 - 01.mkv");
    const digest = digestStaging({
      files: await sandbox.inspectStaging(),
      seasons: [1],
      needCodes: ["S01E01", "S01E02"],
      overrides: { "狂飙 - 01.mkv": "S01E01" },
    });
    // digest 层面通过了(overrides 让代码以为覆盖了 S01E01)。
    expect(digest.episodeCodes).toEqual(["S01E01"]);
    expect(digest.passes).toBe(true);

    const result = await finalizeLanding({
      sandbox,
      digest,
      canonicalTitle: "狂飙",
      seasons: [1],
      overrides: { "狂飙 - 01.mkv": "S01E01" },
    });
    // 映射表让 rename 落地:原名 `狂飙 - 01.mkv` → `狂飙.S01E01.mkv`。
    expect(result.renamed).toEqual(["狂飙.S01E01.mkv"]);
    expect(result.marked).toEqual(["S01E01"]);
    // 归位到 Season 1(staging 里 rename 后 move 过去)。staging 目录被 wipe 删除,
    // 文件系统里只剩 season 目录里这一份。
    expect(result.discarded.length).toBeGreaterThan(0); // staging wipe:文件+目录 id
    expect((await storage.listTree({ directoryId: s1 })).map((f) => f.path)).toEqual(["狂飙.S01E01.mkv"]);
  });

  it("功能3 空洞校验: digest 有 code 但无 overrides 时 rename 无法落地 → mark 保持空(不以 digest 为准)", async () => {
    // 同一文件 `狂飙 - 01.mkv` 但 finalize 没收到 overrides(例如映射未传下来):
    // digest 说它是 S01E01,但 rename 按裸文件名解析不出 → renamed 空 → mark 空。
    const { sandbox, storage, stagingDirectoryId, s1 } = await createSandbox(["S01E01", "S01E02"]);
    await landFile(storage, stagingDirectoryId, "狂飙 - 01.mkv");
    const digest = digestStaging({
      files: await sandbox.inspectStaging(),
      seasons: [1],
      needCodes: ["S01E01", "S01E02"],
      overrides: { "狂飙 - 01.mkv": "S01E01" },
    });
    expect(digest.passes).toBe(true);

    const result = await finalizeLanding({ sandbox, digest, canonicalTitle: "狂飙", seasons: [1] });
    expect(result.renamed).toEqual([]);
    expect(result.marked).toEqual([]);
    expect(await storage.listTree({ directoryId: s1 })).toEqual([]);
  });