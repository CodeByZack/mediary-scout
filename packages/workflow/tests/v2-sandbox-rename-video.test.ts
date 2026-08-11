import { describe, expect, it } from "vitest";
import { TaskSandbox } from "../src/acquisition-v2/sandbox.js";
import { FakeResourceProviderV2 } from "../src/acquisition-v2/fake-provider.js";
import { Storage115Simulator } from "../src/acquisition-v2/storage-115-simulator.js";
import { episodeCodeFromFileName } from "../src/episode-code.js";

/** Build a TaskSandbox wired to a fake video provider + sim storage, with a
 *  staging dir and a Season 1 target (TV/anime shape by default). */
async function createVideoSandbox(options: {
  canonicalTitle?: string;
  canonicalYear?: number;
} = {}) {
  const provider = new FakeResourceProviderV2({ results: { title: [] } });
  const storage = new Storage115Simulator({ packs: {} });
  const stagingDirectoryId = await storage.createDirectory({ name: "staging", parentId: "root" });
  const targetSeasonDirectoryId = await storage.createDirectory({ name: "Season 1", parentId: "root" });
  const sandbox = new TaskSandbox({
    provider,
    storage,
    stagingDirectoryId,
    targetSeasonDirectoryIds: { 1: targetSeasonDirectoryId },
    need: ["S01E01"],
    ...(options.canonicalTitle !== undefined ? { canonicalTitle: options.canonicalTitle } : {}),
    ...(options.canonicalYear !== undefined ? { canonicalYear: options.canonicalYear } : {}),
  });
  return { sandbox, storage, stagingDirectoryId };
}

/** Land a file (any extension) into staging via the sim's subtitle URL transfer —
 *  the established test pattern for materializing files with a chosen filename. */
async function landFile(storage: Storage115Simulator, stagingDirectoryId: string, filename: string) {
  const [id] = (await storage.transferSubtitleUrl({
    url: "http://x/file",
    filename,
    intoDirectoryId: stagingDirectoryId,
  })).materializedFileIds;
  return id!;
}

describe("renameVideo (batch, per-item guards) — TV/anime shape", () => {
  it("renames a whole batch of videos to canonical names in ONE call (errors absent)", async () => {
    const { sandbox, storage, stagingDirectoryId } = await createVideoSandbox({ canonicalTitle: "Show" });
    const v1 = await landFile(storage, stagingDirectoryId, "Show - 01.mkv");
    const v2 = await landFile(storage, stagingDirectoryId, "Show - 02.mkv");

    const out = await sandbox.renameVideo({
      renames: [
        { fileId: v1, newName: "Show.S01E01.mkv" },
        { fileId: v2, newName: "Show.S01E02.mkv" },
      ],
    });

    expect(out.renamed).toEqual(["Show.S01E01.mkv", "Show.S01E02.mkv"]);
    expect(out.errors).toBeUndefined();
    const staging = await storage.listTree({ directoryId: stagingDirectoryId });
    expect(staging.map((f) => f.path)).toEqual(["Show.S01E01.mkv", "Show.S01E02.mkv"]);
  });

  it("collects a per-item error for a fileId not in staging", async () => {
    const { sandbox } = await createVideoSandbox();
    const out = await sandbox.renameVideo({ renames: [{ fileId: "not-in-staging", newName: "Show.S01E01.mkv" }] });
    expect(out.renamed).toEqual([]);
    expect(out.errors![0]!.error).toMatch(/NOT_IN_STAGING/i);
  });

  it("collects a per-item error when the SOURCE is not a video (subtitles stay un-renameable by renameVideo)", async () => {
    const { sandbox, storage, stagingDirectoryId } = await createVideoSandbox();
    const sub = await landFile(storage, stagingDirectoryId, "raw.ass");
    const out = await sandbox.renameVideo({ renames: [{ fileId: sub, newName: "Show.S01E01.ass" }] });
    expect(out.renamed).toEqual([]);
    expect(out.errors![0]!.error).toMatch(/NOT_A_VIDEO|only videos/i);
  });

  it("collects a per-item error for path separators in newName", async () => {
    const { sandbox, storage, stagingDirectoryId } = await createVideoSandbox();
    const v = await landFile(storage, stagingDirectoryId, "Show - 01.mkv");
    const out = await sandbox.renameVideo({ renames: [{ fileId: v, newName: "sub/Show.S01E01.mkv" }] });
    expect(out.renamed).toEqual([]);
    expect(out.errors![0]!.error).toMatch(/path separator|INVALID_VIDEO_NAME/i);
  });

  it("collects a per-item error when newName drops the video extension", async () => {
    const { sandbox, storage, stagingDirectoryId } = await createVideoSandbox();
    const v = await landFile(storage, stagingDirectoryId, "Show - 01.mkv");
    const out = await sandbox.renameVideo({ renames: [{ fileId: v, newName: "Show.S01E01" }] });
    expect(out.renamed).toEqual([]);
    expect(out.errors![0]!.error).toMatch(/INVALID_VIDEO_NAME|video extension/i);
  });

  it("collects a per-item error when a TV newName carries no episode code (SxxExx)", async () => {
    const { sandbox, storage, stagingDirectoryId } = await createVideoSandbox();
    const v = await landFile(storage, stagingDirectoryId, "Show - 01.mkv");
    const out = await sandbox.renameVideo({ renames: [{ fileId: v, newName: "Show.mkv" }] });
    expect(out.renamed).toEqual([]);
    expect(out.errors![0]!.error).toMatch(/episode code|SxxExx|INVALID_VIDEO_NAME/i);
  });

  it("collects a per-item error for filename-hostile characters", async () => {
    const { sandbox, storage, stagingDirectoryId } = await createVideoSandbox();
    const v = await landFile(storage, stagingDirectoryId, "Show - 01.mkv");
    const out = await sandbox.renameVideo({ renames: [{ fileId: v, newName: 'Show: S01E01?*"<>|.mkv' }] });
    expect(out.renamed).toEqual([]);
    expect(out.errors![0]!.error).toMatch(/INVALID_VIDEO_NAME|not allowed/i);
  });
});

describe("renameVideo — movie shape `Title (Year).ext`", () => {
  it("accepts the canonical movie shape when canonicalYear matches", async () => {
    const { sandbox, storage, stagingDirectoryId } = await createVideoSandbox({
      canonicalTitle: "奥本海默",
      canonicalYear: 2023,
    });
    const v = await landFile(storage, stagingDirectoryId, "Oppenheimer.2023.2160p.mkv");
    const out = await sandbox.renameVideo({ renames: [{ fileId: v, newName: "奥本海默 (2023).mkv" }] });
    expect(out.renamed).toEqual(["奥本海默 (2023).mkv"]);
    expect(out.errors).toBeUndefined();
  });

  it("rejects a movie newName without the (Year) shape", async () => {
    const { sandbox, storage, stagingDirectoryId } = await createVideoSandbox({
      canonicalTitle: "奥本海默",
      canonicalYear: 2023,
    });
    const v = await landFile(storage, stagingDirectoryId, "Oppenheimer.2023.2160p.mkv");
    const out = await sandbox.renameVideo({ renames: [{ fileId: v, newName: "Oppenheimer.2023.mkv" }] });
    expect(out.renamed).toEqual([]);
    expect(out.errors![0]!.error).toMatch(/Title \(Year\)|INVALID_VIDEO_NAME/i);
  });

  it("rejects a movie newName whose year differs from canonicalYear", async () => {
    const { sandbox, storage, stagingDirectoryId } = await createVideoSandbox({
      canonicalTitle: "奥本海默",
      canonicalYear: 2023,
    });
    const v = await landFile(storage, stagingDirectoryId, "Oppenheimer.2023.2160p.mkv");
    const out = await sandbox.renameVideo({ renames: [{ fileId: v, newName: "奥本海默 (2024).mkv" }] });
    expect(out.renamed).toEqual([]);
    expect(out.errors![0]!.error).toMatch(/year|INVALID_VIDEO_NAME/i);
  });

  it("rejects a movie-shaped newName with a non-video extension (extension guard wins)", async () => {
    const { sandbox, storage, stagingDirectoryId } = await createVideoSandbox({
      canonicalTitle: "奥本海默",
      canonicalYear: 2023,
    });
    const v = await landFile(storage, stagingDirectoryId, "Oppenheimer.2023.2160p.mkv");
    const out = await sandbox.renameVideo({ renames: [{ fileId: v, newName: "奥本海默 (2023).ass" }] });
    expect(out.renamed).toEqual([]);
    expect(out.errors![0]!.error).toMatch(/video extension|INVALID_VIDEO_NAME/i);
  });
});

describe("renameVideo — batch mechanics", () => {
  it("rejects an empty renames array loudly", async () => {
    const { sandbox } = await createVideoSandbox();
    await expect(sandbox.renameVideo({ renames: [] })).rejects.toThrow(/empty|至少/i);
  });

  it("serves the whole batch with ONE staging listTree (no per-file 115 burn)", async () => {
    const provider = new FakeResourceProviderV2({ results: { title: [] } });
    class CountingListStorage extends Storage115Simulator {
      listTreeCalls = 0;
      override async listTree(input: { directoryId: string }) {
        this.listTreeCalls += 1;
        return super.listTree(input);
      }
    }
    const storage = new CountingListStorage({ packs: {} });
    const stagingDirectoryId = await storage.createDirectory({ name: "staging", parentId: "root" });
    const targetSeasonDirectoryId = await storage.createDirectory({ name: "Season 1", parentId: "root" });
    const v1 = await landFile(storage, stagingDirectoryId, "Show - 01.mkv");
    const v2 = await landFile(storage, stagingDirectoryId, "Show - 02.mkv");
    const bad = await landFile(storage, stagingDirectoryId, "Show - 03.mkv");
    const sandbox = new TaskSandbox({
      provider,
      storage,
      stagingDirectoryId,
      targetSeasonDirectoryIds: { 1: targetSeasonDirectoryId },
      need: ["S01E01"],
    });
    storage.listTreeCalls = 0;

    const result = await sandbox.renameVideo({
      renames: [
        { fileId: v1, newName: "Show.S01E01.mkv" },
        { fileId: v2, newName: "Show.S01E02.mkv" },
        { fileId: bad, newName: "Show.mkv" }, // 无集号:守卫必须拦,其余照常
      ],
    });

    expect(result.renamed).toEqual(["Show.S01E01.mkv", "Show.S01E02.mkv"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors![0]!.error).toMatch(/episode code|SxxExx|INVALID_VIDEO_NAME/i);
    expect(storage.listTreeCalls).toBe(1); // 整批一次 listTree
  });

  it("renamed files stay re-parseable: episodeCodeFromFileName recovers the code (identity contract)", async () => {
    const { sandbox, storage, stagingDirectoryId } = await createVideoSandbox({ canonicalTitle: "庆余年" });
    const v = await landFile(storage, stagingDirectoryId, "第3集.mp4");
    await sandbox.renameVideo({ renames: [{ fileId: v, newName: "庆余年.S03E03.mp4" }] });

    const [renamed] = await storage.listTree({ directoryId: stagingDirectoryId });
    expect(renamed!.path).toBe("庆余年.S03E03.mp4");
    expect(episodeCodeFromFileName(renamed!.path)).toBe("S03E03");
  });
});
