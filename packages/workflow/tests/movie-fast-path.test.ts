import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { TaskSandbox } from "../src/acquisition-v2/sandbox.js";
import { FakeResourceProviderV2 } from "../src/acquisition-v2/fake-provider.js";
import { Storage115Simulator } from "../src/acquisition-v2/storage-115-simulator.js";
import { runMovieFastPathAcquisition } from "../src/acquisition-v2/fast-path.js";
import { makeAgentTraceSink } from "../src/acquisition-v2/agent-trace-sink.js";
import { InMemoryWorkflowRepository } from "../src/index.js";
import type { MovieTarget } from "../src/acquisition-v2/task-agents.js";
import type { MediaTitle, ResourceSnapshot } from "../src/domain.js";
import { FakeStorageExecutor } from "../src/fakes.js";
import { runMovieAcquisitionV2 } from "../src/movie-workflow-v2.js";
import type { ResourceProvider } from "../src/ports.js";

/** Let the trace sink's fire-and-forget append chain settle (same as
 *  agent-trace-sink.test.ts). */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

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
  /** Additional keyword → candidates for the alias 兜底重搜 rounds. */
  extraResults?: Record<string, Array<{ id: string; title: string }>>;
  /** Counts every provider.search call (primary prime + fallback rounds). */
  onSearch?: () => void;
}

/** Movie setup: staging === the movie dir (flatten-in-place, per §5), so BOTH
 *  sandbox handles point at the same directory — matching movie-workflow-v2. */
async function createMovieSetup(options: SetupOptions) {
  const provider = new FakeResourceProviderV2({
    results: { 流浪地球: options.candidates, ...options.extraResults },
    ...(options.onSearch ? { onSearch: options.onSearch } : {}),
  });
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

  it("gracefully reports no_coverage when the movie arbitrator returns a TITLE as candidateId", async () => {
    // No unique A-grade → arbitrator sees only the graded summary and (the bug)
    // fills the TITLE back as candidateId. The guard must catch it and conclude
    // uncovered — transferCandidate must never throw SANDBOX_CANDIDATE_NOT_IN_SNAPSHOT.
    const { sandbox } = await createMovieSetup({
      candidates: [
        { id: "c1", title: "流浪地球 4K" }, // B — no year in release name
        { id: "c2", title: "流浪地球 1080p" }, // B — no year in release name
      ],
      packs: {},
    });

    const result = await runMovieFastPathAcquisition({
      sandbox,
      model: textModel('{"candidateId":"流浪地球","reasoning":"选流浪地球"}'),
      target: movieTarget,
    });

    expect(result.escalated).toBe(true);
    expect(result.coverage.coverageMet).toBe(false);
    expect(result.coverage.missing).toEqual(["MOVIE"]);
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

  it("reports unmet coverage when every candidate is a dead link (dead-link scan, zero real transfers)", async () => {
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

    // Four A-grades (all year-match) → no unique top → arbitrator picks c1; then
    // dead links are scanned (cheap fail-loud probes, NOT transfer attempts) —
    // all four are dead, the pool is exhausted, and ZERO real transfers happened.
    const result = await runMovieFastPathAcquisition({
      sandbox,
      model: textModel('{"candidateId":"c1","reasoning":"选第一个"}'),
      target: movieTarget,
    });

    expect(result.coverage.coverageMet).toBe(false);
    expect(result.coverage.missing).toEqual(["MOVIE"]);
    expect(result.steps).toBe(0); // 全是死链：死链不占转存次数，零真实转存
  });

  it("dead links do NOT consume transfer attempts — scans past 3 dead links to the live candidate", async () => {
    const { sandbox, movieDir, storage } = await createMovieSetup({
      candidates: [
        { id: "c1", title: "流浪地球.2019.4K" },
        { id: "c2", title: "流浪地球.2019.4K.中字" },
        { id: "c3", title: "流浪地球.2019.1080p" },
        { id: "c4", title: "流浪地球 2019" },
      ],
      packs: { c4: { files: [{ path: "流浪地球 (2019).mkv", sizeBytes: 2_000_000_000 }] } },
      failureMessages: { c1: "dead share", c2: "dead share", c3: "dead share" },
    });

    // 4 A-grades → arbitrator picks c1; c1/c2/c3 are dead links (not counted),
    // c4 lands — exactly ONE real transfer attempt.
    const result = await runMovieFastPathAcquisition({
      sandbox,
      model: textModel('{"candidateId":"c1","reasoning":"选第一个"}'),
      target: movieTarget,
    });

    expect(result.coverage.coverageMet).toBe(true);
    expect(result.coverage.obtained).toEqual(["MOVIE"]);
    expect(result.steps).toBe(1);
    expect((await storage.listTree({ directoryId: movieDir })).map((f) => f.path)).toEqual([
      "流浪地球 (2019).mkv",
    ]);
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

  it("空快照时用 aliases 兜底重搜（movie twin），命中唯一 A（标题+年份）直接盲转", async () => {
    let searches = 0;
    const fallbackMovieTarget: MovieTarget = {
      ...movieTarget,
      aliases: ["The Wandering Earth"], // 流浪地球 英文原名
    };
    const { sandbox, movieDir, storage } = await createMovieSetup({
      candidates: [], // 流浪地球 title 预搜落空 → 触发兜底
      extraResults: {
        "the wandering earth": [{ id: "c1", title: "The Wandering Earth.2019.4K" }],
      },
      packs: {
        c1: { files: [{ path: "The Wandering Earth.2019.4K.mkv", sizeBytes: 2_000_000_000 }] },
      },
      onSearch: () => {
        searches += 1;
      },
    });

    const result = await runMovieFastPathAcquisition({
      sandbox,
      model: throwModel(),
      target: fallbackMovieTarget,
    });

    expect(result.escalated).toBe(false); // 兜底命中唯一 A → 零 LLM
    expect(result.coverage.coverageMet).toBe(true);
    expect(result.coverage.obtained).toEqual(["MOVIE"]);
    expect(searches).toBe(2); // 1 预搜 + 1 兜底
    // 兜底命中的影片被 flatten + canonical 重命名。
    expect((await storage.listTree({ directoryId: movieDir })).map((f) => f.path)).toEqual([
      "流浪地球 (2019).mkv",
    ]);
  });

  it("标题搜索无唯一 A（两个 A 平级）时用 aliases 兜底（movie twin），命中唯一 A 直接盲转", async () => {
    let searches = 0;
    const fallbackMovieTarget: MovieTarget = {
      ...movieTarget,
      aliases: ["The Wandering Earth"],
    };
    const { sandbox, movieDir, storage } = await createMovieSetup({
      candidates: [
        { id: "c1", title: "流浪地球.2019.4K" },
        { id: "c2", title: "流浪地球.2019.1080p" }, // 两个 A → 无唯一 top → 触发兜底
      ],
      extraResults: {
        "the wandering earth": [{ id: "c3", title: "The Wandering Earth.2019.4K" }],
      },
      packs: {
        c3: { files: [{ path: "The Wandering Earth.2019.4K.mkv", sizeBytes: 2_000_000_000 }] },
      },
      onSearch: () => {
        searches += 1;
      },
    });

    const result = await runMovieFastPathAcquisition({
      sandbox,
      model: throwModel(),
      target: fallbackMovieTarget,
    });

    expect(result.escalated).toBe(false);
    expect(result.coverage.coverageMet).toBe(true);
    expect(result.coverage.obtained).toEqual(["MOVIE"]);
    expect(searches).toBe(2);
    expect((await storage.listTree({ directoryId: movieDir })).map((f) => f.path)).toEqual([
      "流浪地球 (2019).mkv",
    ]);
  });
});

describe("runMovieFastPathAcquisition — §C aliases 兜底重搜", () => {
  /** C-specific movie setup: per-keyword results + target aliases + search
   *  counter. primeRawSnapshot("流浪地球") = the orchestrator pre-warm (#1). */
  async function createMovieAliasSetup(options: {
    results: Record<string, Array<{ id: string; title: string }>>;
    errorKeywords?: string[];
    packs: Record<string, { files: Array<{ path: string; sizeBytes: number }> }>;
    aliases: string[];
  }) {
    const searches: string[] = [];
    const provider = new FakeResourceProviderV2({
      results: options.results,
      ...(options.errorKeywords ? { errorKeywords: options.errorKeywords } : {}),
      onSearch: () => {
        searches.push("x");
      },
    });
    const storage = new Storage115Simulator({ packs: options.packs });
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
    const aliasTarget: MovieTarget = {
      title: "流浪地球",
      aliases: options.aliases,
      year: 2019,
      qualityPreference: "4K",
    };
    return { sandbox, storage, movieDir, aliasTarget, searches };
  }

  it("兜底:primary 空快照 + alias 命中唯一 A(title+年份) → 直接转存(零 LLM)", async () => {
    const { sandbox, movieDir, storage, aliasTarget, searches } = await createMovieAliasSetup({
      results: {
        流浪地球: [], // primary title → 0 候选
        "The Wandering Earth": [{ id: "c1", title: "流浪地球.2019.4K.中字" }], // 译名 → 唯一 A
      },
      packs: { c1: { files: [{ path: "流浪地球.2019.4K.mkv", sizeBytes: 2_000_000_000 }] } },
      aliases: ["The Wandering Earth"],
    });

    const result = await runMovieFastPathAcquisition({
      sandbox,
      model: throwModel(),
      target: aliasTarget,
    });

    expect(result.escalated).toBe(false);
    expect(result.coverage.coverageMet).toBe(true);
    expect(result.coverage.obtained).toEqual(["MOVIE"]);
    expect((await storage.listTree({ directoryId: movieDir })).map((f) => f.path)).toEqual([
      "流浪地球 (2019).mkv",
    ]);
    expect(searches.length).toBe(2); // 1 primary + 1 alias
  });

  it("兜底:primary 无唯一 A + alias 命中唯一 A → 直接转存(零 LLM)", async () => {
    const { sandbox, movieDir, storage, aliasTarget, searches } = await createMovieAliasSetup({
      results: {
        流浪地球: [
          { id: "c1", title: "流浪地球 4K" }, // B — 无年份
          { id: "c2", title: "流浪地球 1080p" }, // B — 无年份
        ],
        "The Wandering Earth": [{ id: "c3", title: "流浪地球.2019.4K.中字" }], // 唯一 A
      },
      packs: { c3: { files: [{ path: "流浪地球.2019.4K.mkv", sizeBytes: 2_000_000_000 }] } },
      aliases: ["The Wandering Earth"],
    });

    const result = await runMovieFastPathAcquisition({
      sandbox,
      model: throwModel(),
      target: aliasTarget,
    });

    expect(result.escalated).toBe(false);
    expect(result.coverage.coverageMet).toBe(true);
    expect((await storage.listTree({ directoryId: movieDir })).map((f) => f.path)).toEqual([
      "流浪地球 (2019).mkv",
    ]);
    expect(searches.length).toBe(2); // 1 primary + 1 alias
  });

  it("兜底:aliases 为空 → 行为与原来完全一致(空快照 1 次搜索即放弃)", async () => {
    const { sandbox, aliasTarget, searches } = await createMovieAliasSetup({
      results: { 流浪地球: [] },
      packs: {},
      aliases: [],
    });

    const result = await runMovieFastPathAcquisition({
      sandbox,
      model: throwModel(),
      target: aliasTarget,
    });

    expect(result.coverage.coverageMet).toBe(false);
    expect(result.escalated).toBe(false);
    expect(searches.length).toBe(1); // 无兜底
  });

  it("兜底全失败且 primary 有候选 → 恢复 primary 快照继续仲裁(movie twin)", async () => {
    const { sandbox, movieDir, storage, aliasTarget, searches } = await createMovieAliasSetup({
      results: {
        流浪地球: [
          { id: "c1", title: "流浪地球 4K" }, // B — 无年份
          { id: "c2", title: "流浪地球 1080p" }, // B — 无年份
        ], // 无唯一 A → 触发兜底
        "The Wandering Earth": [], // 兜底命中 0 → 旧行为:最后一个兜底快照为空覆盖 primary → 误报「暂无资源(快照为空)」
      },
      packs: { c1: { files: [{ path: "流浪地球.2019.4K.mkv", sizeBytes: 2_000_000_000 }] } },
      aliases: ["The Wandering Earth"],
    });

    const result = await runMovieFastPathAcquisition({
      sandbox,
      model: textModel('{"candidateId":"c1","reasoning":"primary 候选"}'),
      target: aliasTarget,
    });

    expect(result.escalated).toBe(true); // 回到 primary 走仲裁(而非直接放弃)
    expect(result.coverage.coverageMet).toBe(true); // 不是「暂无资源(快照为空)」
    expect((await storage.listTree({ directoryId: movieDir })).map((f) => f.path)).toEqual([
      "流浪地球 (2019).mkv",
    ]);
    expect(searches.length).toBe(2); // 1 primary + 1 兜底;恢复 primary 零额外搜索
  });
});

describe("runMovieFastPathAcquisition — 步骤写入 agent_steps（Task D）", () => {
  it("成功转存路径:每步写一条 AgentStep(落点检查→预搜→评分→选片→转存→digest→归位→结论)", async () => {
    const repo = new InMemoryWorkflowRepository();
    const trace = makeAgentTraceSink({ repository: repo, workflowRunId: "run-mfp-d1" });
    const { sandbox, movieDir, storage } = await createMovieSetup({
      candidates: [{ id: "c1", title: "流浪地球.2019.4K.中字" }],
      packs: { c1: { files: [{ path: "流浪地球.2019.4K.mkv", sizeBytes: 2_000_000_000 }] } },
    });

    const result = await runMovieFastPathAcquisition({
      sandbox,
      model: throwModel(),
      target: movieTarget,
      onProgress: trace,
    });

    expect(result.coverage.coverageMet).toBe(true);
    await tick();
    const steps = await repo.listAgentSteps("run-mfp-d1");
    expect(steps.map((s) => s.toolName)).toEqual([
      "inspectTargetDir",
      "viewResourceSnapshot",
      "gradeCandidates",
      "pickCandidate",
      "transferCandidate",
      "stagingDigest",
      "finalizeLanding",
      "finish",
    ]);
    expect(steps.map((s) => s.phase)).toEqual([
      "search",
      "search",
      "search",
      "pick",
      "transfer",
      "verify",
      "organize",
      "finalize",
    ]);
    // activity = stepLog 的 detail;序号连续;markObtained 的 MOVIE sentinel 不污染计数
    expect(steps.map((s) => s.ordinal)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(steps[1]!.activity).toBe("候选 1 条");
    expect(steps[7]!.activity).toBe("入库(MOVIE)");
    expect((await storage.listTree({ directoryId: movieDir })).map((f) => f.path)).toEqual([
      "流浪地球 (2019).mkv",
    ]);
  });

  it("影片已在库路径:写 markObtained(MOVIE, mark 阶段)+ 结论步骤", async () => {
    const repo = new InMemoryWorkflowRepository();
    const trace = makeAgentTraceSink({ repository: repo, workflowRunId: "run-mfp-d2" });
    const provider = new FakeResourceProviderV2({ results: { 流浪地球: [] } });
    const storage = new Storage115Simulator({ packs: {} });
    const movieDir = await storage.createDirectory({ name: "流浪地球 (2019)", parentId: "root" });
    // Place a film directly on disk (already-on-disk scenario).
    await storage.transferSubtitleUrl({
      url: "http://x/流浪地球.2019.4K.mkv",
      filename: "流浪地球.2019.4K.mkv",
      intoDirectoryId: movieDir,
    });
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

    const result = await runMovieFastPathAcquisition({
      sandbox,
      model: throwModel(),
      target: movieTarget,
      onProgress: trace,
    });

    expect(result.coverage.coverageMet).toBe(true);
    await tick();
    const steps = await repo.listAgentSteps("run-mfp-d2");
    expect(steps.map((s) => s.toolName)).toEqual(["inspectTargetDir", "markObtained", "finish"]);
    expect(steps.map((s) => s.phase)).toEqual(["search", "mark", "finalize"]);
    expect(steps[1]!.args.codes).toEqual(["MOVIE"]);
  });

  it("无候选路径:写 reportNoCoverage 结论步骤(写失败静默,不崩溃)", async () => {
    const repo = new InMemoryWorkflowRepository();
    const trace = makeAgentTraceSink({ repository: repo, workflowRunId: "run-mfp-d3" });
    const { sandbox } = await createMovieSetup({ candidates: [], packs: {} });

    const result = await runMovieFastPathAcquisition({
      sandbox,
      model: throwModel(),
      target: movieTarget,
      onProgress: trace,
    });

    expect(result.coverage.coverageMet).toBe(false);
    await tick();
    const steps = await repo.listAgentSteps("run-mfp-d3");
    expect(steps.map((s) => s.toolName)).toEqual([
      "inspectTargetDir",
      "viewResourceSnapshot",
      "reportNoCoverage",
    ]);
    expect(steps[2]!.activity).toBe("暂无资源(快照为空)");
  });
});
