import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { TaskSandbox } from "../src/acquisition-v2/sandbox.js";
import { FakeResourceProviderV2 } from "../src/acquisition-v2/fake-provider.js";
import { Storage115Simulator } from "../src/acquisition-v2/storage-115-simulator.js";
import { runMovieFastPathAcquisition } from "../src/acquisition-v2/fast-path.js";
import type { MovieTarget } from "../src/acquisition-v2/task-agents.js";
import type { MediaTitle, ResourceSnapshot } from "../src/domain.js";
import { FakeStorageExecutor } from "../src/fakes.js";
import { runMovieAcquisitionV2 } from "../src/movie-workflow-v2.js";
import type { ResourceProvider } from "../src/ports.js";

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
      throw new Error("MODEL_SHOULD_NOT_BE_CALLED: movie fast path must stay zero-LLM");
    },
  });
}

const movieTarget: MovieTarget = {
  title: "流浪地球",
  aliases: [],
  year: 2019,
  qualityPreference: "4K",
};

interface SetupOptions {
  candidates: Array<{ id: string; title: string }>;
  packs: Record<string, { files: Array<{ path: string; sizeBytes: number }> }>;
  failureMessages?: Record<string, string>;
}

/** Movie setup: staging === the movie dir (flatten-in-place, per §5), so BOTH
 *  sandbox handles point at the same directory — matching movie-workflow-v2. */
async function createMovieSetup(options: SetupOptions) {
  const provider = new FakeResourceProviderV2({ results: { 流浪地球: options.candidates } });
  const storage = new Storage115Simulator({
    packs: options.packs,
    ...(options.failureMessages ? { failureMessages: options.failureMessages } : {}),
  });
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
  await sandbox.primeRawSnapshot("流浪地球");
  return { sandbox, storage, movieDir };
}

describe("runMovieFastPathAcquisition — the movie zero-LLM happy path", () => {
  it("transfers a unique A-grade (title + year), flattens + renames, marks MOVIE, zero LLM", async () => {
    const { sandbox, movieDir, storage } = await createMovieSetup({
      candidates: [
        { id: "c1", title: "流浪地球.2019.4K.中字" },
        { id: "c2", title: "流浪地球.2023.4K" }, // year mismatch → C (同名异作 trap)
      ],
      packs: { c1: { files: [{ path: "流浪地球.2019.4K.mkv", sizeBytes: 2_000_000_000 }] } },
    });

    const result = await runMovieFastPathAcquisition({
      sandbox,
      model: throwModel(),
      target: movieTarget,
    });

    expect(result.escalated).toBe(false);
    expect(result.coverage.coverageMet).toBe(true);
    expect(result.coverage.obtained).toEqual(["MOVIE"]);
    // The film was flattened + canonical-renamed in the movie dir.
    expect((await storage.listTree({ directoryId: movieDir })).map((f) => f.path)).toEqual([
      "流浪地球 (2019).mkv",
    ]);
  });

  it("escalates to the movie selection arbitrator when there is no unique A-grade", async () => {
    const { sandbox, movieDir, storage } = await createMovieSetup({
      candidates: [
        { id: "c1", title: "流浪地球 4K" }, // B — no year in release name
        { id: "c2", title: "流浪地球 1080p" }, // B — no year in release name
      ],
      packs: { c1: { files: [{ path: "流浪地球.2019.4K.mkv", sizeBytes: 2_000_000_000 }] } },
    });

    const result = await runMovieFastPathAcquisition({
      sandbox,
      model: textModel('{"candidateId":"c1","reasoning":"唯一候选"}'),
      target: movieTarget,
    });

    expect(result.escalated).toBe(true);
    expect(result.coverage.coverageMet).toBe(true);
    expect((await storage.listTree({ directoryId: movieDir })).map((f) => f.path)).toEqual([
      "流浪地球 (2019).mkv",
    ]);
  });

  it("declines (no coverage) when the selection arbitrator finds nothing usable", async () => {
    const { sandbox } = await createMovieSetup({
      candidates: [{ id: "c1", title: "流浪地球 4K" }],
      packs: {},
    });

    const result = await runMovieFastPathAcquisition({
      sandbox,
      model: textModel('{"candidateId":null,"reasoning":"无法确认是目标影片"}'),
      target: movieTarget,
    });

    expect(result.coverage.coverageMet).toBe(false);
    expect(result.coverage.missing).toEqual(["MOVIE"]);
  });

  it("escalates to the diagnostic arbitrator on a dirty landing (2 videos), honors accept, keeps the largest film", async () => {
    const { sandbox, movieDir, storage } = await createMovieSetup({
      candidates: [{ id: "c1", title: "流浪地球.2019.4K" }], // unique A → blind transfer
      packs: {
        c1: {
          files: [
            { path: "trailer/流浪地球.预告.mkv", sizeBytes: 100_000_000 },
            { path: "流浪地球.2019.4K.mkv", sizeBytes: 2_000_000_000 },
          ],
        },
      },
    });

    const result = await runMovieFastPathAcquisition({
      sandbox,
      model: textModel('{"action":"accept","reasoning":"预告片不影响正片"}'),
      target: movieTarget,
    });

    expect(result.escalated).toBe(true);
    expect(result.coverage.coverageMet).toBe(true);
    // Only the largest video (the film) survives; the trailer + wrapper are gone.
    expect((await storage.listTree({ directoryId: movieDir })).map((f) => f.path)).toEqual([
      "流浪地球 (2019).mkv",
    ]);
  });

  it("retries the next candidate when the diagnosis says retry_other, after clearing the bad landing", async () => {
    const { sandbox, movieDir, storage } = await createMovieSetup({
      candidates: [
        { id: "c1", title: "流浪地球.2019.4K" }, // unique A → blind transfer first
        { id: "c2", title: "流浪地球 4K" }, // B
      ],
      packs: {
        c1: { files: [{ path: "流浪地球.2023.mkv", sizeBytes: 1 }] }, // remake (wrong year)
        c2: { files: [{ path: "流浪地球.2019.1080p.mkv", sizeBytes: 1_000_000_000 }] },
      },
    });

    // c1's landing digests as ONE video → passes is TRUE, but it is the WRONG film
    // (2023 remake). The movie digest cannot know that in code — the DIAGNOSTIC
    // arbitrator sees the summary and says retry_other; c2 lands clean.
    const result = await runMovieFastPathAcquisition({
      sandbox,
      model: textModel('{"action":"retry_other","reasoning":"年份不对，疑似 remake"}'),
      target: movieTarget,
    });

    expect(result.coverage.coverageMet).toBe(true);
    expect((await storage.listTree({ directoryId: movieDir })).map((f) => f.path)).toEqual([
      "流浪地球 (2019).mkv",
    ]);
  });

  it("clears a subtitle-only landing before advancing (no residue rides the next flatten)", async () => {
    const { sandbox, movieDir, storage } = await createMovieSetup({
      candidates: [
        { id: "c1", title: "流浪地球.2019.4K" }, // unique A → blind transfer first
        { id: "c2", title: "流浪地球 4K" }, // B
      ],
      packs: {
        // c1 lands ONLY a subtitle (stray pack) — no video → advance like a dead
        // link, but the stray subtitle must NOT linger into c2's flatten.
        c1: { files: [{ path: "流浪地球.zh.ass", sizeBytes: 50_000 }] },
        c2: { files: [{ path: "流浪地球.2019.4K.mkv", sizeBytes: 2_000_000_000 }] },
      },
    });

    const result = await runMovieFastPathAcquisition({
      sandbox,
      model: throwModel(),
      target: movieTarget,
    });

    expect(result.coverage.coverageMet).toBe(true);
    // Exactly ONE file: the film. The stray subtitle was cleared, not renamed+kept.
    expect((await storage.listTree({ directoryId: movieDir })).map((f) => f.path)).toEqual([
      "流浪地球 (2019).mkv",
    ]);
  });

  it("reports unmet coverage when every candidate is a dead link (attempt cap 3)", async () => {
    const { sandbox } = await createMovieSetup({
      candidates: [
        { id: "c1", title: "流浪地球.2019.4K" },
        { id: "c2", title: "流浪地球.2019.4K.中字" },
        { id: "c3", title: "流浪地球.2019.1080p" },
        { id: "c4", title: "流浪地球 2019" },
      ],
      packs: {},
      failureMessages: { c1: "dead share", c2: "dead share", c3: "dead share", c4: "dead share" },
    });

    // Three A-grades (all year-match) → no unique top → arbitrator picks c1; then
    // dead links burn the remaining attempts up to the cap of 3.
    const result = await runMovieFastPathAcquisition({
      sandbox,
      model: textModel('{"candidateId":"c1","reasoning":"选第一个"}'),
      target: movieTarget,
    });

    expect(result.coverage.coverageMet).toBe(false);
    expect(result.coverage.missing).toEqual(["MOVIE"]);
    expect(result.steps).toBe(3); // MAX_TRANSFER_ATTEMPTS
  });

  it("marks MOVIE when the film is already on disk and never searches or transfers", async () => {
    const provider = new FakeResourceProviderV2({ results: {} });
    const storage = new Storage115Simulator({
      packs: { seed: { files: [{ path: "流浪地球 (2019).mkv", sizeBytes: 2_000_000_000 }] } },
    });
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
    await sandbox.primeRawSnapshot("流浪地球");
    // The film is already on disk in the movie dir (prior run / crash-left).
    await storage.transferCandidate({ candidateId: "seed", intoDirectoryId: movieDir });

    const result = await runMovieFastPathAcquisition({
      sandbox,
      model: throwModel(),
      target: movieTarget,
    });

    expect(result.escalated).toBe(false);
    expect(result.coverage.coverageMet).toBe(true);
    expect(result.coverage.obtained).toEqual(["MOVIE"]);
  });

  it("systemic transfer block (配额不足) → honest 转存失败 report, NOT no_coverage (fast path 别甩锅)", async () => {
    // The fast path transfers a unique A-grade (title + year) BLIND — no LLM. The
    // account can't materialize it (115 云下载配额不足) → systemic block. The
    // workflow MUST report 转存失败 (actionable: 升级VIP/买配额), never
    // "暂未找到资源" — the resource exists, the account is blocked. This is the
    // fast path's own 别甩锅 coverage (the agent-path twin lives in
    // v2-movie-workflow.test.ts); CI previously only exercised the agent twin.
    const candidateId = "cand_q";
    const executor = new FakeStorageExecutor({
      transferOutcomes: {
        [candidateId]: { status: "failed", providerMessage: "云下载配额不足，请升级VIP获得赠送配额或购买云下载配额！", files: [] },
      },
    });
    const provider: ResourceProvider = {
      search: async ({ keyword }): Promise<ResourceSnapshot> => ({
        id: "snap_q",
        provider: "pansou",
        keyword,
        candidates: [
          {
            id: candidateId,
            snapshotId: "snap_q",
            index: 0,
            title: "流浪地球 2019 4K", // unique A-grade: title + year match → blind transfer
            type: "magnet",
            source: "pansou",
            providerPayload: { url: "magnet:?xt=urn:btih:deadbeef" },
          },
        ],
        createdAt: "2026-06-14T00:00:00.000Z",
      }),
    };

    const result = await runMovieAcquisitionV2({
      title: {
        id: "tmdb_movie_189645",
        tmdbId: 189645,
        title: "流浪地球",
        year: 2019,
        aliases: [],
        type: "movie",
      } as unknown as MediaTitle,
      resourceProvider: provider,
      storage: executor,
      // No preferredLanguage → orchestrator routes to the fast path; the unique
      // A-grade transfers without arbitration, so the LLM must never be called.
      model: throwModel(),
      workflowRunId: "run-fast-blocked",
      moviesParentDirectoryId: "movies_root",
      now: () => "2026-06-14T00:00:00.000Z",
    });

    expect(result.status).toBe("no_coverage");
    expect(result.notification.report?.status).toBe("failed");
    expect(result.notification.body).toContain("转存失败");
    expect(result.notification.body).toContain("配额");
    expect(result.notification.body).not.toContain("暂未找到");
    expect(result.notification.kind).toBe("transfer_failed");
  });
});
