import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { runMovieAcquisitionV2 } from "../src/movie-workflow-v2.js";
import { FakeStorageExecutor } from "../src/fakes.js";
import type { ResourceProvider } from "../src/ports.js";
import type { MediaTitle, ResourceSnapshot } from "../src/domain.js";

const USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
} as const;

function emptyProvider(): ResourceProvider {
  return {
    search: async ({ keyword }): Promise<ResourceSnapshot> => ({
      id: "snap_empty",
      provider: "pansou",
      keyword,
      candidates: [],
      createdAt: "2026-06-14T00:00:00.000Z",
    }),
  };
}

/** Build a MockLanguageModelV3 that emits the given tool calls in order, then stops. */
function scriptModel(steps: Array<{ tool: string; input: unknown }>) {
  let i = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      if (i < steps.length) {
        const step = steps[i]!;
        i += 1;
        return {
          content: [{ type: "tool-call" as const, toolCallId: `c${i}`, toolName: step.tool, input: JSON.stringify(step.input) }],
          finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const },
          usage: USAGE,
          warnings: [],
        };
      }
      return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" as const }, usage: USAGE, warnings: [] };
    },
  });
}

/** A model that always returns the given text — used to script the movie selection arbitrator. */
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

/** A model that THROWS if invoked — proves a path never calls the LLM. */
function throwModel() {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      throw new Error("MODEL_SHOULD_NOT_BE_CALLED: movie fast path must stay zero-LLM");
    },
  });
}

/** Records every createDirectory call so a test can assert NO separate staging dir is made. */
class RecordingExecutor extends FakeStorageExecutor {
  readonly createdDirs: Array<{ name: string; parentId: string }> = [];
  override async createDirectory(input: { name: string; parentId: string }): Promise<string> {
    this.createdDirs.push(input);
    return super.createDirectory(input);
  }
}

const title = {
  id: "tmdb_movie_27205",
  tmdbId: 27205,
  title: "盗梦空间",
  year: 2010,
  aliases: ["Inception"],
  type: "movie",
} as unknown as MediaTitle;

describe("runMovieAcquisitionV2 — obtained comes from the AGENT'S coverage, never a mechanical file count", () => {
  it("no coverage → status no_coverage, the synthetic movie episode is not obtained", async () => {
    const executor = new FakeStorageExecutor();
    const result = await runMovieAcquisitionV2({
      title,
      resourceProvider: emptyProvider(),
      storage: executor,
      model: scriptModel([
        { tool: "searchResources", input: { keyword: "盗梦空间" } },
        { tool: "reportNoCoverage", input: { reason: "no candidates" } },
      ]),
      workflowRunId: "run-m1",
      moviesParentDirectoryId: "movies_root",
      now: () => "2026-06-14T00:00:00.000Z",
    });

    expect(result.status).toBe("no_coverage");
    expect(result.episodes).toHaveLength(1);
    expect(result.episodes[0]!.obtained).toBe(false);
    expect(result.notification.kind).toBe("no_coverage");
    expect(result.season.storageDirectoryId).toContain("movies_root"); // movie dir verify-or-created
    // 病4: the movie path's bridged auditEvents carry the honest report — parity
    // with the TV e2e (sandbox → orchestrator → movie workflow persistence).
    expect(result.auditEvents.some((e) => e.type === "no_coverage_reported")).toBe(true);
  });

  it("transfers systemically BLOCKED (配额不足) → honest 转存失败 report, NOT 暂未找到资源 (别甩锅)", async () => {
    // The resource EXISTS (a candidate is found + transfer attempted) but the
    // account can't materialize it (115 云下载配额不足). The report must say so,
    // not blame the resource — mirrors the real 心灵奇旅-on-free-account incident.
    // Movie now runs the FAST PATH: the candidate is not a unique A-grade (target
    // 盗梦空间 vs 心灵奇旅), so the selection arbitrator picks it, then the
    // transfer surfaces the systemic block.
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
            title: "心灵奇旅 2020 1080p",
            type: "magnet",
            source: "pansou",
            providerPayload: { url: "magnet:?xt=urn:btih:deadbeef" },
          },
        ],
        createdAt: "2026-06-14T00:00:00.000Z",
      }),
    };

    const result = await runMovieAcquisitionV2({
      title,
      resourceProvider: provider,
      storage: executor,
      // The movie selection arbitrator gets ONE call and must return the real
      // candidate id (not a title — the arbitrator defends against made-up ids).
      model: textModel(JSON.stringify({ candidateId, reasoning: "唯一可用候选" })),
      workflowRunId: "run-blocked",
      moviesParentDirectoryId: "movies_root",
      now: () => "2026-06-14T00:00:00.000Z",
    });

    expect(result.episodes[0]!.obtained).toBe(false);
    expect(result.notification.report?.status).toBe("failed");
    expect(result.notification.body).toContain("转存失败");
    expect(result.notification.body).toContain("配额");
    expect(result.notification.body).not.toContain("暂未找到");
    expect(result.notification.kind).toBe("transfer_failed");
  });

  it("obtained TRUE when a unique A-grade lands and marks MOVIE (fast path, zero LLM)", async () => {
    const executor = new FakeStorageExecutor({
      // The movie fast path needs a REAL materialized landing: seed the transfer
      // outcome so the video actually appears in the movie dir.
      defaultTransferOutcome: {
        status: "succeeded",
        providerMessage: "fake transfer completed",
        files: [
          {
            id: "fake_movie_ok",
            storageDirectoryId: "assigned_by_fake_storage",
            name: "盗梦空间.2010.1080p.mkv",
            sizeBytes: 2_000_000_000,
            episodeCode: "S01E01",
            providerFileId: "provider_fake_movie_ok",
          },
        ],
      },
    });
    const result = await runMovieAcquisitionV2({
      title,
      resourceProvider: {
        search: async ({ keyword }): Promise<ResourceSnapshot> => ({
          id: "snap_ok",
          provider: "pansou",
          keyword,
          candidates: [
            {
              id: "cand_ok",
              snapshotId: "snap_ok",
              index: 0,
              title: "盗梦空间 2010 4K 中字",
              type: "magnet",
              source: "pansou",
              providerPayload: { url: "magnet:?xt=urn:btih:ok" },
            },
          ],
          createdAt: "2026-06-14T00:00:00.000Z",
        }),
      },
      storage: executor,
      model: throwModel(),
      workflowRunId: "run-m2",
      moviesParentDirectoryId: "movies_root",
      preferredLanguage: "中文",
      now: () => "2026-06-14T00:00:00.000Z",
    });

    expect(result.status).toBe("succeeded");
    expect(result.episodes[0]!.obtained).toBe(true);
  });

  it("国产片(CN) never triggers the subtitle stage — no subtitle capability wiring on CN runs", async () => {
    // The movie route is all fast path; the orchestrator only wires the subtitle
    // stage for NON-CN films. On a CN title, the acquisition is pure video —
    // no assrt, no 可能无中文字幕 flag (the deterministic picker either lands a
    // matching package or degrades silently).
    const executor = new FakeStorageExecutor({
      defaultTransferOutcome: {
        status: "succeeded",
        providerMessage: "fake transfer completed",
        files: [
          {
            id: "fake_movie_cn",
            storageDirectoryId: "assigned_by_fake_storage",
            name: "流浪地球.2019.4K.mkv",
            sizeBytes: 2_000_000_000,
            episodeCode: "S01E01",
            providerFileId: "provider_fake_movie_cn",
          },
        ],
      },
    });
    const result = await runMovieAcquisitionV2({
      title: { ...title, title: "流浪地球", year: 2019, originCountries: ["CN"] },
      resourceProvider: {
        search: async ({ keyword }): Promise<ResourceSnapshot> => ({
          id: "snap_cn",
          provider: "pansou",
          keyword,
          candidates: [
            {
              id: "cand_cn",
              snapshotId: "snap_cn",
              index: 0,
              title: "流浪地球 2019 4K",
              type: "magnet",
              source: "pansou",
              providerPayload: { url: "magnet:?xt=urn:btih:cn" },
            },
          ],
          createdAt: "2026-06-14T00:00:00.000Z",
        }),
      },
      storage: executor,
      model: throwModel(),
      workflowRunId: "run-m-cn",
      moviesParentDirectoryId: "movies_root",
      preferredLanguage: "中文",
      now: () => "2026-06-14T00:00:00.000Z",
    });

    expect(result.status).toBe("succeeded");
    expect(result.episodes[0]!.obtained).toBe(true);
    expect(result.notification.report?.lines.some((l) => l.includes("可能无中文字幕"))).toBe(false);
  });

  it("a stray non-video file in the movie dir does NOT mark MOVIE (only an actual video does)", async () => {
    // Fast-path landing-point check: the movie dir holding a VIDEO (a prior run's
    // film) → mark MOVIE. A stray SUBTITLE/junk file is NOT a film — the run must
    // still search and transfer. This pins the mechanical landing-point rule.
    const executor = new FakeStorageExecutor({
      defaultTransferOutcome: {
        status: "succeeded",
        providerMessage: "fake transfer completed",
        files: [
          {
            id: "fake_movie_stray",
            storageDirectoryId: "assigned_by_fake_storage",
            name: "盗梦空间.2010.4K.mkv",
            sizeBytes: 2_000_000_000,
            episodeCode: "S01E01",
            providerFileId: "provider_fake_movie_stray",
          },
        ],
      },
    });
    const movieDir = await executor.createDirectory({ name: "盗梦空间 (2010)", parentId: "movies_root" });
    executor.seedDirectoryFiles(movieDir, [
      { id: "stray-sub", storageDirectoryId: movieDir, name: "随便.ass", sizeBytes: 1, episodeCode: null, providerFileId: "stray-sub" },
    ]);

    const result = await runMovieAcquisitionV2({
      title,
      resourceProvider: {
        search: async ({ keyword }): Promise<ResourceSnapshot> => ({
          id: "snap_stray",
          provider: "pansou",
          keyword,
          candidates: [
            {
              id: "cand_stray",
              snapshotId: "snap_stray",
              index: 0,
              title: "盗梦空间 2010 4K",
              type: "magnet",
              source: "pansou",
              providerPayload: { url: "magnet:?xt=urn:btih:stray" },
            },
          ],
          createdAt: "2026-06-14T00:00:00.000Z",
        }),
      },
      storage: executor,
      // A unique A-grade lands → transfer → digest → mark MOVIE, all in code.
      model: throwModel(),
      workflowRunId: "run-m3",
      moviesParentDirectoryId: "movies_root",
      now: () => "2026-06-14T00:00:00.000Z",
    });

    expect(result.status).toBe("succeeded");
    expect(result.episodes[0]!.obtained).toBe(true);
  });

  it("uses NO separate staging directory — staging IS the movie dir (flatten in place)", async () => {
    const executor = new RecordingExecutor();
    await runMovieAcquisitionV2({
      title,
      resourceProvider: emptyProvider(),
      storage: executor,
      model: scriptModel([
        { tool: "searchResources", input: { keyword: "盗梦空间" } },
        { tool: "reportNoCoverage", input: { reason: "no candidates" } },
      ]),
      workflowRunId: "run-m4",
      moviesParentDirectoryId: "movies_root",
      now: () => "2026-06-14T00:00:00.000Z",
    });

    // Exactly one directory is created — the movie dir. No `staging-*` sibling.
    expect(executor.createdDirs).toEqual([
      { name: "盗梦空间 (2010) {tmdb-27205}", parentId: "movies_root" },
    ]);
  });
});
