import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { TaskSandbox } from "../src/acquisition-v2/sandbox.js";
import { FakeResourceProviderV2 } from "../src/acquisition-v2/fake-provider.js";
import { Storage115Simulator } from "../src/acquisition-v2/storage-115-simulator.js";
import { runFastPathAcquisition } from "../src/acquisition-v2/fast-path.js";
import type { TvAnimeTarget } from "../src/acquisition-v2/task-agents.js";

const USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
} as const;

function textModel(text: string) {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text" as const, text }],
      finishReason: { unified: "stop" as const, raw: "stop" as const },
      usage: USAGE,
      warnings: [],
    }),
  });
}

/** A model that THROWS if invoked — proves the happy path never calls the LLM. */
function throwModel() {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      throw new Error("MODEL_SHOULD_NOT_BE_CALLED: fast path must stay zero-LLM");
    },
  });
}

const target: TvAnimeTarget = {
  title: "狂飙",
  aliases: [],
  seasons: [1],
  missingEpisodes: ["S01E01"],
};

/** Storage whose moveFiles fails — proves finalize's honest-termination contract. */
class MoveFailingSimulator extends Storage115Simulator {
  override async moveFiles(input: {
    fileIds: string[];
    targetDirectoryId: string;
  }): Promise<{ moved: string[] }> {
    throw new Error("SANDBOX_MOVE_FAILED: injected for the honest-termination test");
  }
}

interface SetupOptions {
  candidates: Array<{ id: string; title: string }>;
  packs: Record<string, { files: Array<{ path: string; sizeBytes: number }> }>;
  failureMessages?: Record<string, string>;
  need?: string[];
}

async function createSetup(options: SetupOptions) {
  const provider = new FakeResourceProviderV2({ results: { 狂飙: options.candidates } });
  const storage = new Storage115Simulator({
    packs: options.packs,
    ...(options.failureMessages ? { failureMessages: options.failureMessages } : {}),
  });
  const stagingDirectoryId = await storage.createDirectory({ name: "staging", parentId: "root" });
  const s1 = await storage.createDirectory({ name: "Season 1", parentId: "root" });
  const sandbox = new TaskSandbox({
    provider,
    storage,
    stagingDirectoryId,
    targetSeasonDirectoryIds: { 1: s1 },
    need: options.need ?? ["S01E01"],
    canonicalTitle: "狂飙",
    titleTerms: ["狂飙"],
  });
  await sandbox.primeRawSnapshot("狂飙");
  return { sandbox, storage, s1 };
}

describe("runFastPathAcquisition — the zero-LLM happy path", () => {
  it("transfers a unique A-grade, finalizes, and NEVER calls the model", async () => {
    const { sandbox, s1, storage } = await createSetup({
      candidates: [
        { id: "c1", title: "狂飙.S01E01.1080p.中字" },
        { id: "c2", title: "别的剧 S01 全集" },
      ],
      packs: { c1: { files: [{ path: "狂飙.S01E01.mkv", sizeBytes: 1_000_000_000 }] } },
    });

    const result = await runFastPathAcquisition({
      sandbox,
      model: throwModel(),
      target,
      isChineseNative: false,
    });

    expect(result.escalated).toBe(false);
    expect(result.coverage.coverageMet).toBe(true);
    expect(result.coverage.obtained).toEqual(["S01E01"]);
    // The file was renamed + 归位 into the season dir.
    expect((await storage.listTree({ directoryId: s1 })).map((f) => f.path)).toEqual([
      "狂飙.S01E01.mkv",
    ]);
  });

  it("escalates to the selection arbitrator when there is no unique A-grade", async () => {
    const { sandbox, s1, storage } = await createSetup({
      candidates: [
        { id: "c1", title: "狂飙.S01E01.1080p.中字" },
        { id: "c2", title: "狂飙.S01E02.1080p.中字" },
      ],
      packs: { c1: { files: [{ path: "狂飙.S01E01.mkv", sizeBytes: 1 }] } },
    });

    const result = await runFastPathAcquisition({
      sandbox,
      model: textModel('{"candidateId":"c1","reasoning":"更早一集"}'),
      target,
      isChineseNative: false,
    });

    expect(result.escalated).toBe(true);
    expect(result.coverage.coverageMet).toBe(true);
    expect((await storage.listTree({ directoryId: s1 })).map((f) => f.path)).toEqual([
      "狂飙.S01E01.mkv",
    ]);
  });

  it("declines (no coverage) when the arbitrator finds nothing usable", async () => {
    const { sandbox } = await createSetup({
      candidates: [
        { id: "c1", title: "狂飙 电影版" },
        { id: "c2", title: "狂飙 真人版" },
      ],
      packs: {},
    });

    const result = await runFastPathAcquisition({
      sandbox,
      model: textModel('{"candidateId":null,"reasoning":"全是同名异作"}'),
      target,
      isChineseNative: false,
    });

    expect(result.coverage.coverageMet).toBe(false);
    expect(result.coverage.missing).toEqual(["S01E01"]);
  });

  it("escalates to the diagnostic arbitrator on a dirty landing, and honors accept", async () => {
    const { sandbox, s1, storage } = await createSetup({
      candidates: [{ id: "c1", title: "狂飙.S01E01.1080p.中字" }],
      packs: {
        c1: {
          files: [
            { path: "狂飙.S01E01.mkv", sizeBytes: 1_000_000_000 },
            { path: "狂飙.S01E01.sample.mkv", sizeBytes: 50_000_000 },
          ],
        },
      },
    });

    const result = await runFastPathAcquisition({
      sandbox,
      model: textModel('{"action":"accept","reasoning":"sample 不影响正片"}'),
      target,
      isChineseNative: false,
    });

    expect(result.escalated).toBe(true);
    expect(result.coverage.coverageMet).toBe(true);
    // Only the real episode was renamed + moved; the sample stays out of the season.
    expect((await storage.listTree({ directoryId: s1 })).map((f) => f.path)).toEqual([
      "狂飙.S01E01.mkv",
    ]);
  });

  it("retries the next candidate when the diagnostic arbitrator says retry_other", async () => {
    const { sandbox, s1, storage } = await createSetup({
      candidates: [
        { id: "c1", title: "狂飙.S01E01.1080p.中字" }, // unique A-grade
        { id: "c2", title: "狂飙" }, // B-grade (bare title)
      ],
      packs: {
        c1: { files: [{ path: "狂飙.S02E01.mkv", sizeBytes: 1 }] }, // wrong season
        c2: { files: [{ path: "狂飙.S01E01.mkv", sizeBytes: 1 }] },
      },
    });

    // The selection needs no arbitration (c1 is a unique A-grade); only the
    // diagnosis of c1's wrong-season landing calls the model → retry_other,
    // which transfers c2 (clean) without a second call.
    const result = await runFastPathAcquisition({
      sandbox,
      model: textModel('{"action":"retry_other","reasoning":"季号错了"}'),
      target,
      isChineseNative: false,
    });

    expect(result.coverage.coverageMet).toBe(true);
    expect((await storage.listTree({ directoryId: s1 })).map((f) => f.path)).toEqual([
      "狂飙.S01E01.mkv",
    ]);
  });

  it("reports unmet coverage when every candidate is a dead link", async () => {
    const { sandbox } = await createSetup({
      candidates: [{ id: "c1", title: "狂飙.S01E01.1080p.中字" }],
      packs: {},
      failureMessages: { c1: "dead share" },
    });

    const result = await runFastPathAcquisition({
      sandbox,
      model: throwModel(),
      target,
      isChineseNative: false,
    });

    expect(result.coverage.coverageMet).toBe(false);
    expect(result.coverage.missing).toEqual(["S01E01"]);
  });

  it("marks already-on-disk episodes and never searches or transfers (§6b#8)", async () => {
    const provider = new FakeResourceProviderV2({ results: {} });
    const storage = new Storage115Simulator({
      packs: { seed: { files: [{ path: "狂飙.S01E01.mkv", sizeBytes: 1_000_000_000 }] } },
    });
    const stagingDirectoryId = await storage.createDirectory({ name: "staging", parentId: "root" });
    const s1 = await storage.createDirectory({ name: "Season 1", parentId: "root" });
    const sandbox = new TaskSandbox({
      provider,
      storage,
      stagingDirectoryId,
      targetSeasonDirectoryIds: { 1: s1 },
      need: ["S01E01"],
      canonicalTitle: "狂飙",
      titleTerms: ["狂飙"],
    });
    await sandbox.primeRawSnapshot("狂飙");
    // The episode is already on disk in the season dir (the DB-lags-the-disk case).
    await storage.transferCandidate({ candidateId: "seed", intoDirectoryId: s1 });

    const result = await runFastPathAcquisition({
      sandbox,
      model: throwModel(),
      target,
      isChineseNative: false,
    });

    expect(result.escalated).toBe(false);
    expect(result.coverage.coverageMet).toBe(true);
    expect(result.coverage.obtained).toEqual(["S01E01"]);
  });

  it("reports honest no-coverage (never a fake obtained) when moveToSeason fails", async () => {
    const provider = new FakeResourceProviderV2({
      results: { 狂飙: [{ id: "c1", title: "狂飙.S01E01.1080p.中字" }] },
    });
    const storage = new MoveFailingSimulator({
      packs: { c1: { files: [{ path: "狂飙.S01E01.mkv", sizeBytes: 1_000_000_000 }] } },
    });
    const stagingDirectoryId = await storage.createDirectory({ name: "staging", parentId: "root" });
    const s1 = await storage.createDirectory({ name: "Season 1", parentId: "root" });
    const sandbox = new TaskSandbox({
      provider,
      storage,
      stagingDirectoryId,
      targetSeasonDirectoryIds: { 1: s1 },
      need: ["S01E01"],
      canonicalTitle: "狂飙",
      titleTerms: ["狂飙"],
    });
    await sandbox.primeRawSnapshot("狂飙");

    const result = await runFastPathAcquisition({
      sandbox,
      model: throwModel(),
      target,
      isChineseNative: false,
    });

    expect(result.coverage.coverageMet).toBe(false);
    expect(result.coverage.obtained).toEqual([]); // never a fake obtained mark
  });
});
