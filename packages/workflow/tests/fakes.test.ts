import { describe, expect, it } from "vitest";
import { FakeResourceProvider, FakeStorageExecutor } from "../src/fakes.js";
import type { ResourceCandidate, VerifiedFile } from "../src/domain.js";

describe("FakeResourceProvider catch-all (defaultKeywordResult)", () => {
  it("known keyword still returns its configured candidates", async () => {
    const provider = new FakeResourceProvider({
      keywordResults: { "剧名 4K": [{ title: "剧名 S01E01-S01E12 4K" }] },
    });
    const snapshot = await provider.search({ keyword: "剧名 4K" });
    expect(snapshot.candidates.map((c) => c.title)).toEqual(["剧名 S01E01-S01E12 4K"]);
  });

  it("unknown keyword without catch-all stays empty (existing behavior)", async () => {
    const provider = new FakeResourceProvider({ keywordResults: {} });
    const snapshot = await provider.search({ keyword: "随便搜" });
    expect(snapshot.candidates).toEqual([]);
  });

  it("unknown keyword with static catch-all returns the fallback candidate", async () => {
    const provider = new FakeResourceProvider({
      keywordResults: {},
      defaultKeywordResult: { title: "兜底候选", source: "fake" },
    });
    const snapshot = await provider.search({ keyword: "随便搜" });
    expect(snapshot.candidates).toHaveLength(1);
    expect(snapshot.candidates[0]!.title).toBe("兜底候选");
    expect(snapshot.candidates[0]!.source).toBe("fake");
  });

  it("function catch-all receives the keyword and may return multiple candidates", async () => {
    const provider = new FakeResourceProvider({
      keywordResults: {},
      defaultKeywordResult: (keyword) => [
        { title: `${keyword} S01E01-S01E24 4K`, source: "fake" },
        { title: `${keyword} 第一季 1080P`, source: "fake" },
      ],
    });
    const snapshot = await provider.search({ keyword: "生化危机：爆发夜" });
    expect(snapshot.candidates.map((c) => c.title)).toEqual([
      "生化危机：爆发夜 S01E01-S01E24 4K",
      "生化危机：爆发夜 第一季 1080P",
    ]);
  });

  it("keywordErrors still win over catch-all", async () => {
    const provider = new FakeResourceProvider({
      keywordResults: {},
      keywordErrors: { boom: "provider down" },
      defaultKeywordResult: () => ({ title: "兜底", source: "fake" }),
    });
    await expect(provider.search({ keyword: "boom" })).rejects.toThrow("provider down");
  });
});

describe("FakeStorageExecutor movieStagingRoots (fake runtime mode)", () => {
  const tvDump: VerifiedFile[] = [
    { id: "f1", storageDirectoryId: "x", name: "Show.S01E01.mkv", sizeBytes: 1, episodeCode: "S01E01", providerFileId: "p1" },
    { id: "f2", storageDirectoryId: "x", name: "Show.S01E02.mkv", sizeBytes: 1, episodeCode: "S01E02", providerFileId: "p2" },
  ];
  const film: VerifiedFile[] = [
    { id: "m1", storageDirectoryId: "x", name: "Fake.Movie.1080p.mkv", sizeBytes: 1, episodeCode: "S01E01", providerFileId: "pm1" },
  ];
  const candidate: ResourceCandidate = {
    id: "snap_9_candidate_1", snapshotId: "snap_9", index: 0,
    title: "某电影 1080p", type: "115", source: "fake", providerPayload: {},
  };
  const executor = new FakeStorageExecutor({
    defaultTransferOutcome: { status: "succeeded", providerMessage: "tv", files: tvDump },
    movieStagingRoots: ["fake_movies_root"],
    movieTransferOutcome: { status: "succeeded", providerMessage: "movie", files: film },
    transferOutcomes: { snap_9_candidate_1: { status: "succeeded", providerMessage: "keyed-tv", files: tvDump } },
  });

  it("a landing under a movie root gets the single-film outcome (keyed TV outcome loses)", async () => {
    const attempt = await executor.transfer({ workflowRunId: "r1", directoryId: "fake_movies_root_某电影_1", candidate });
    expect(attempt.status).toBe("succeeded");
    expect(attempt.materializedFileIds).toEqual(["m1"]);
  });

  it("non-movie landings keep the candidate-keyed / TV behavior", async () => {
    const attempt = await executor.transfer({ workflowRunId: "r2", directoryId: "fake_library_root_1", candidate });
    expect(attempt.materializedFileIds).toEqual(["f1", "f2"]);
  });

  it("unset movieStagingRoots (all existing tests) ⇒ unchanged behavior", async () => {
    const plain = new FakeStorageExecutor({
      defaultTransferOutcome: { status: "succeeded", providerMessage: "tv", files: tvDump },
    });
    const attempt = await plain.transfer({ workflowRunId: "r3", directoryId: "fake_movies_root_anything", candidate });
    expect(attempt.materializedFileIds).toEqual(["f1", "f2"]);
  });
});
