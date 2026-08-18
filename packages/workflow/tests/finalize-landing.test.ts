import { describe, expect, it } from "vitest";
import { TaskSandbox } from "../src/acquisition-v2/sandbox.js";
import { FakeResourceProviderV2 } from "../src/acquisition-v2/fake-provider.js";
import { Storage115Simulator } from "../src/acquisition-v2/storage-115-simulator.js";
import { digestStaging } from "../src/acquisition-v2/staging-digest.js";
import { buildSeasonMoves, finalizeLanding, seasonFromEpisodeCode } from "../src/acquisition-v2/finalize-landing.js";

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
