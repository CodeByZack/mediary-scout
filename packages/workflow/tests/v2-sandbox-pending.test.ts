import { describe, expect, it } from "vitest";
import { TaskSandbox } from "../src/acquisition-v2/sandbox.js";
import { FakeResourceProviderV2 } from "../src/acquisition-v2/fake-provider.js";
import { Storage115Simulator } from "../src/acquisition-v2/storage-115-simulator.js";
import { finalizeFromPending } from "../src/acquisition-v2/finalize-landing.js";

async function setup() {
  const provider = new FakeResourceProviderV2({ results: { show: [] } });
  const storage = new Storage115Simulator({ packs: {} });
  const stagingDirectoryId = await storage.createDirectory({ name: "staging", parentId: "root" });
  const pendingDirectoryId = await storage.createDirectory({ name: "pending", parentId: "root" });
  const targetSeasonDirectoryId = await storage.createDirectory({ name: "Season 1", parentId: "root" });
  const sandbox = new TaskSandbox({
    provider,
    storage,
    stagingDirectoryId,
    pendingDirectoryId,
    targetSeasonDirectoryIds: { 1: targetSeasonDirectoryId },
  });
  return { sandbox, storage, stagingDirectoryId };
}

async function landFile(storage: Storage115Simulator, stagingDirectoryId: string, filename: string) {
  const [id] = (await storage.transferSubtitleUrl({
    url: "http://x/file",
    filename,
    intoDirectoryId: stagingDirectoryId,
  })).materializedFileIds;
  return id!;
}

describe("TaskSandbox — pending tools", () => {
  it("inspectPending returns empty when nothing has been moved", async () => {
    const { sandbox } = await setup();
    const tree = await sandbox.inspectPending();
    expect(tree).toEqual([]);
  });

  it("moveToPending moves a video from staging to pending", async () => {
    const { sandbox, storage, stagingDirectoryId } = await setup();
    const videoId = await landFile(storage, stagingDirectoryId, "Show - 01.mkv");
    await sandbox.moveToPending({
      moves: [{ fileId: videoId, newName: "Show.S01E01.mkv" }],
    });

    const pending = await sandbox.inspectPending();
    expect(pending.map((f) => f.path)).toEqual(["Show.S01E01.mkv"]);

    const staging = await sandbox.inspectStaging();
    expect(staging).toEqual([]);
  });

  it("moveToPending moves video + subtitle together", async () => {
    const { sandbox, storage, stagingDirectoryId } = await setup();
    const videoId = await landFile(storage, stagingDirectoryId, "Show - 01.mkv");
    const subId = await landFile(storage, stagingDirectoryId, "show.srt");
    await sandbox.moveToPending({
      moves: [{ fileId: videoId, newName: "Show.S01E01.mkv", subtitleFileIds: [subId] }],
    });

    const pending = await sandbox.inspectPending();
    expect(pending.map((f) => f.path).sort()).toEqual(["Show.S01E01.mkv", "show.srt"]);
  });

  it("moveToPending rejects files not in staging", async () => {
    const { sandbox } = await setup();
    await expect(
      sandbox.moveToPending({ moves: [{ fileId: "nonexistent" }] }),
    ).rejects.toThrow("SANDBOX_FILES_NOT_IN_STAGING");
  });

  it("deleteFromPending removes files from pending", async () => {
    const { sandbox, storage, stagingDirectoryId } = await setup();
    const videoId = await landFile(storage, stagingDirectoryId, "Show - 01.mkv");
    await sandbox.moveToPending({
      moves: [{ fileId: videoId, newName: "Show.S01E01.mkv" }],
    });

    const pending = await sandbox.inspectPending();
    const pendingFile = pending[0]!;
    const result = await sandbox.deleteFromPending({ fileIds: [pendingFile.id] });

    expect(result.deleted).toEqual([pendingFile.id]);
    expect(result.pending).toEqual([]);
  });

  it("deleteFromPending rejects files not in pending", async () => {
    const { sandbox } = await setup();
    await expect(
      sandbox.deleteFromPending({ fileIds: ["nonexistent"] }),
    ).rejects.toThrow("SANDBOX_FILES_NOT_IN_PENDING");
  });

  it("renameInPending renames a file in pending", async () => {
    const { sandbox, storage, stagingDirectoryId } = await setup();
    const videoId = await landFile(storage, stagingDirectoryId, "Show - 01.mkv");
    await sandbox.moveToPending({
      moves: [{ fileId: videoId, newName: "Show.S01E01.mkv" }],
    });

    const pending = await sandbox.inspectPending();
    const result = await sandbox.renameInPending({
      renames: [{ fileId: pending[0]!.id, newName: "Show.S01E02.mkv" }],
    });

    expect(result.renamed.length).toBe(1);
    const updated = await sandbox.inspectPending();
    expect(updated.map((f) => f.path)).toEqual(["Show.S01E02.mkv"]);
  });

  it("renameInPending rejects empty renames", async () => {
    const { sandbox } = await setup();
    await expect(
      sandbox.renameInPending({ renames: [] }),
    ).rejects.toThrow("SANDBOX_EMPTY_RENAMES");
  });

  it("moveToSeasonFromPending moves files from pending to season directory", async () => {
    const { sandbox, storage, stagingDirectoryId } = await setup();
    const videoId = await landFile(storage, stagingDirectoryId, "Show - 01.mkv");
    await sandbox.moveToPending({
      moves: [{ fileId: videoId, newName: "Show.S01E01.mkv" }],
    });

    const pending = await sandbox.inspectPending();
    const result = await sandbox.moveToSeasonFromPending({
      moves: [{ season: 1, fileIds: [pending[0]!.id] }],
    });

    expect(result.seasons[1]!.map((f) => f.path)).toEqual(["Show.S01E01.mkv"]);
    expect(result.pending).toEqual([]);
  });

  it("moveToSeasonFromPending rejects files not in pending", async () => {
    const { sandbox } = await setup();
    await expect(
      sandbox.moveToSeasonFromPending({ moves: [{ season: 1, fileIds: ["nonexistent"] }] }),
    ).rejects.toThrow("SANDBOX_FILES_NOT_IN_PENDING");
  });

  it("moveToSeasonFromPending rejects when no season directory exists", async () => {
    const { sandbox } = await setup();
    await expect(
      sandbox.moveToSeasonFromPending({ moves: [{ season: 99, fileIds: ["x"] }] }),
    ).rejects.toThrow("SANDBOX_SEASON_REQUIRED");
  });
});

describe("finalizeFromPending", () => {
  it("finalizes entries from pending to season directories", async () => {
    const { sandbox, storage, stagingDirectoryId } = await setup();
    const videoId1 = await landFile(storage, stagingDirectoryId, "Show - 01.mkv");
    const videoId2 = await landFile(storage, stagingDirectoryId, "Show - 02.mkv");
    await sandbox.moveToPending({
      moves: [
        { fileId: videoId1, newName: "Show - 01.mkv" },
        { fileId: videoId2, newName: "Show - 02.mkv" },
      ],
    });

    const result = await finalizeFromPending({
      sandbox,
      entries: [
        { code: "S01E01", fileId: videoId1 },
        { code: "S01E02", fileId: videoId2 },
      ],
      canonicalTitle: "Show",
      seasons: [1],
    });

    expect(result.marked).toEqual(["S01E01", "S01E02"]);
    expect(result.movedCount).toBe(2);
    expect(result.renamed.length).toBe(2);
    // Pending should be empty
    const pending = await sandbox.inspectPending();
    expect(pending).toEqual([]);
  });

  it("skips codes not in onlyCodes", async () => {
    const { sandbox, storage, stagingDirectoryId } = await setup();
    const videoId = await landFile(storage, stagingDirectoryId, "Show - 01.mkv");
    await sandbox.moveToPending({
      moves: [{ fileId: videoId, newName: "Show - 01.mkv" }],
    });

    const result = await finalizeFromPending({
      sandbox,
      entries: [{ code: "S01E01", fileId: videoId }],
      canonicalTitle: "Show",
      seasons: [1],
      onlyCodes: ["S01E02"],
    });

    expect(result.marked).toEqual([]);
    expect(result.skippedNotNeeded).toContain("S01E01(not needed)");
  });

  it("skips codes in skipCodes", async () => {
    const { sandbox, storage, stagingDirectoryId } = await setup();
    const videoId = await landFile(storage, stagingDirectoryId, "Show - 01.mkv");
    await sandbox.moveToPending({
      moves: [{ fileId: videoId, newName: "Show - 01.mkv" }],
    });

    const result = await finalizeFromPending({
      sandbox,
      entries: [{ code: "S01E01", fileId: videoId }],
      canonicalTitle: "Show",
      seasons: [1],
      skipCodes: ["S01E01"],
    });

    expect(result.marked).toEqual([]);
    expect(result.skippedOnDisk).toContain("S01E01");
  });
});
