import { describe, expect, it } from "vitest";
import { createStubAcquisitionModel } from "../src/acquisition-v2/stub-model.js";
import { runTvAcquisitionV2 } from "../src/acquisition-v2/run-tv-v2.js";
import { runMovieAcquisitionV2 } from "../src/movie-workflow-v2.js";
import { FakeStorageExecutor, FakeResourceProvider } from "../src/fakes.js";
import type { MediaTitle, ResourceSnapshot } from "../src/domain.js";
import type { ResourceProvider } from "../src/ports.js";

function emptyProvider(): ResourceProvider {
  return {
    search: async ({ keyword }): Promise<ResourceSnapshot> => ({
      id: "snap_empty",
      provider: "pansou",
      keyword,
      candidates: [],
      createdAt: "2026-06-15T00:00:00.000Z",
    }),
  };
}

const tvTitle = {
  id: "tmdb_tv_1",
  tmdbId: 1,
  type: "tv",
  title: "Stub Show",
  year: 2025,
  aliases: [],
} as unknown as MediaTitle;

const movieTitle = {
  id: "tmdb_movie_1",
  tmdbId: 11,
  type: "movie",
  title: "Some Film",
  year: 2025,
  aliases: [],
} as unknown as MediaTitle;

type StubModel = ReturnType<typeof createStubAcquisitionModel>;

interface TvRunOptions {
  provider: ResourceProvider;
  storage?: FakeStorageExecutor;
  model?: StubModel;
  title?: MediaTitle;
  seasons?: Array<{ seasonNumber: number; totalEpisodes: number; latestAiredEpisode: number; qualityPreference: string }>;
  workflowRunId?: string;
}

function tvRun(options: TvRunOptions) {
  return runTvAcquisitionV2({
    title: options.title ?? tvTitle,
    mode: "type2",
    seasons:
      options.seasons ?? [
        { seasonNumber: 1, totalEpisodes: 24, latestAiredEpisode: 24, qualityPreference: "4K" },
      ],
    categoryParentId: "tv_root",
    resourceProvider: options.provider,
    storage: options.storage ?? new FakeStorageExecutor(),
    model: options.model ?? createStubAcquisitionModel(),
    workflowRunId: options.workflowRunId ?? "run-stub",
    now: () => "2026-06-15T00:00:00.000Z",
  });
}

function movieRun(options: { provider: ResourceProvider; storage?: FakeStorageExecutor; model?: StubModel; title?: MediaTitle }) {
  return runMovieAcquisitionV2({
    title: options.title ?? movieTitle,
    resourceProvider: options.provider,
    storage: options.storage ?? new FakeStorageExecutor(),
    model: options.model ?? createStubAcquisitionModel(),
    workflowRunId: "run-movie",
    moviesParentDirectoryId: "movie_root",
    now: () => "2026-06-15T00:00:00.000Z",
  });
}

/** The fake drive dump the preview uses: 3 seasons × 24 episodes land for ANY
 *  candidate — the script must take ONLY the task's need and leave the rest. */
function fullDumpStorage(): FakeStorageExecutor {
  return new FakeStorageExecutor({
    defaultTransferOutcome: {
      status: "succeeded",
      providerMessage: "fake transfer completed",
      files: [1, 2, 3].flatMap((season) =>
        Array.from({ length: 24 }, (_, index) => {
          const code = `S${String(season).padStart(2, "0")}E${String(index + 1).padStart(2, "0")}`;
          return {
            id: `fake_s${season}_${code}`,
            storageDirectoryId: "assigned_by_fake_storage",
            name: `Demo.${code}.mkv`,
            sizeBytes: 1_000_000_000,
            episodeCode: code,
            providerFileId: `provider_fake_s${season}_${code}`,
          };
        }),
      ),
    },
  });
}

/** Storage whose moveToSeason fails — for the honest-termination contract. */
class MoveFailingStorage extends FakeStorageExecutor {
  override async moveFiles(input: { fileIds: string[]; targetDirectoryId: string }): Promise<{ moved: string[] }> {
    throw new Error("SANDBOX_MOVE_FAILED: injected for the honest-termination test");
  }
}

describe("createStubAcquisitionModel — the deterministic-script agent", () => {
  it("reports no_coverage when the search returns no candidates", async () => {
    const result = await tvRun({ provider: emptyProvider() });
    expect(result.status).toBe("no_coverage");
  });

  it("reports no_coverage when the transfer would land nothing", async () => {
    const provider = new FakeResourceProvider({
      keywordResults: {
        "Stub Show": [{ title: "Stub Show S01 全24集", providerPayload: { url: "https://pan.quark.cn/s/abc" } }],
      },
    });
    const storage = new FakeStorageExecutor(); // no outcomes → any transfer fails
    const result = await tvRun({ provider, storage });
    expect(result.status).toBe("no_coverage");
  });

  it("reports no_coverage immediately when the search fails or is refused (no snapshot, no repeated retries)", async () => {
    const provider = new FakeResourceProvider({
      keywordResults: {},
      keywordErrors: { "Stub Show": "provider exploded" },
    });
    const result = await tvRun({ provider, storage: new FakeStorageExecutor() });
    expect(result.status).toBe("no_coverage");
    expect(result.transferAttempts.length).toBe(0);
  });

  it("drives the full happy path: search → 转存 → 改名 → 入库 → 标记, scoped to the task's need", async () => {
    const provider = new FakeResourceProvider({
      keywordResults: {
        "Stub Show": [{ title: "Stub Show S01 全24集", providerPayload: { url: "https://pan.quark.cn/s/abc" } }],
      },
    });
    // Fake drive dumps 3 seasons × 24 episodes for ANY candidate (mimics the
    // preview's defaultTransferOutcome) — the script must take ONLY S01E01-24
    // (the task's need) and leave S02/S03 in staging.
    const storage = fullDumpStorage();

    const result = await tvRun({ provider, storage });

    expect(result.status).toBe("succeeded");
    // Only the 24 needed episodes got marked (S02/S03 extras never marked).
    const landed = result.seasons[0]!.episodes.filter((ep) => ep.obtained);
    expect(landed.length).toBe(24);
    expect(landed.map((ep) => ep.episodeCode)).toEqual(
      Array.from({ length: 24 }, (_, index) => `S01E${String(index + 1).padStart(2, "0")}`),
    );
    // The run's decisions/attempts reflect one real transfer.
    expect(result.transferAttempts.length).toBe(1);
    expect(result.transferAttempts[0]!.status).toBe("succeeded");

    // Directory-level truth: the canonical renames actually landed in the
    // season directory (not just the in-memory obtained marks).
    const showDirs = await storage.listChildDirectories("tv_root");
    const showDir = showDirs.find((dir) => dir.name === "Stub Show (2025) {tmdb-1}");
    expect(showDir).toBeDefined();
    const children = await storage.listChildDirectories(showDir!.id);
    const seasonDir = children.find((dir) => dir.name === "Season 01");
    expect(seasonDir).toBeDefined();
    const seasonTree = await storage.listTree({ directoryId: seasonDir!.id });
    expect(seasonTree.map((file) => file.path).sort()).toEqual(
      Array.from({ length: 24 }, (_, index) => `Stub Show.S01E${String(index + 1).padStart(2, "0")}.mkv`).sort(),
    );
    // discardStaging (or the harness backstop) wiped the run's staging — no
    // S02/S03 extras survive anywhere, and only Season 01 exists (extras were
    // discarded, never mis-moved into a season or marked).
    expect(children.some((dir) => dir.name.startsWith("staging-"))).toBe(false);
    expect(children.map((dir) => dir.name)).not.toContain("Season 02");
    expect(children.map((dir) => dir.name)).not.toContain("Season 03");
  });

  it("resets its plan when the same instance runs a second, different task (regression: agentModelCache reuses the stub across runs)", async () => {
    const provider = new FakeResourceProvider({
      keywordResults: {
        "Stub Show": [{ title: "Stub Show S01 全24集", providerPayload: { url: "https://pan.quark.cn/s/abc" } }],
        "Another Show": [{ title: "Another Show S01 全12集", providerPayload: { url: "https://pan.quark.cn/s/def" } }],
      },
    });
    // Each run gets its OWN storage (the fake's fileIds are per-instance); the
    // point of this test is that the MODEL instance — what the worker's
    // agentModelCache hands to every fake-mode run — is shared.
    const model = createStubAcquisitionModel();

    const run1 = await tvRun({ provider, storage: fullDumpStorage(), model });
    expect(run1.status).toBe("succeeded");
    expect(run1.transferAttempts.length).toBe(1);

    // Second run on the SAME model instance, different title + different need.
    const secondTitle = {
      id: "tmdb_tv_2",
      tmdbId: 2,
      type: "tv",
      title: "Another Show",
      year: 2026,
      aliases: [],
    } as unknown as MediaTitle;
    const run2 = await tvRun({
      provider,
      storage: fullDumpStorage(),
      model,
      title: secondTitle,
      workflowRunId: "run-stub-2",
      seasons: [{ seasonNumber: 1, totalEpisodes: 12, latestAiredEpisode: 12, qualityPreference: "4K" }],
    });
    // Without the reset this would silently idle: 0 tool calls, 0 marks,
    // honest-looking no_coverage. It must run the full script for ITS task.
    expect(run2.status).toBe("succeeded");
    expect(run2.transferAttempts.length).toBe(1);
    const landed2 = run2.seasons[0]!.episodes.filter((ep) => ep.obtained);
    expect(landed2.length).toBe(12);
    expect(landed2.map((ep) => ep.episodeCode)).toEqual(
      Array.from({ length: 12 }, (_, index) => `S01E${String(index + 1).padStart(2, "0")}`),
    );
  });

  it("honestly reports no_coverage (never a fake obtained) when moveToSeason fails", async () => {
    const provider = new FakeResourceProvider({
      keywordResults: {
        "Stub Show": [{ title: "Stub Show S01 全24集", providerPayload: { url: "https://pan.quark.cn/s/abc" } }],
      },
    });
    const storage = new MoveFailingStorage({
      defaultTransferOutcome: {
        status: "succeeded",
        providerMessage: "fake transfer completed",
        files: [
          {
            id: "fake_s1_S01E01",
            storageDirectoryId: "assigned_by_fake_storage",
            name: "Demo.S01E01.mkv",
            sizeBytes: 1_000_000_000,
            episodeCode: "S01E01",
            providerFileId: "provider_fake_s1_S01E01",
          },
        ],
      },
    });
    const result = await tvRun({ provider, storage });
    // The batch move threw → nothing was placed in the season → the script must
    // NOT mark obtained and must surface no_coverage instead of succeeded.
    expect(result.status).toBe("no_coverage");
    const landed = result.seasons[0]!.episodes.filter((ep) => ep.obtained);
    expect(landed.length).toBe(0);
  });

  it("movie happy path: search → 转存 → inspect → flattenMovie → mark MOVIE → finish", async () => {
    const provider = new FakeResourceProvider({
      keywordResults: {
        "Some Film": [{ title: "Some Film 2025 1080p", providerPayload: { url: "https://pan.quark.cn/s/abc" } }],
      },
    });
    const storage = new FakeStorageExecutor({
      defaultTransferOutcome: {
        status: "succeeded",
        providerMessage: "fake transfer completed",
        files: [
          {
            id: "fake_movie_1",
            storageDirectoryId: "assigned_by_fake_storage",
            name: "Some.Film.2025.1080p.mkv",
            sizeBytes: 2_000_000_000,
            episodeCode: "S01E01",
            providerFileId: "provider_fake_movie_1",
          },
        ],
      },
    });

    const result = await movieRun({ provider, storage });

    expect(result.status).toBe("succeeded");
    expect(result.episodes[0]!.obtained).toBe(true);
    expect(result.transferAttempts.length).toBe(1);
    expect(result.transferAttempts[0]!.status).toBe("succeeded");
    // The film actually landed and was flattened/renamed into the movie dir.
    const movieDirs = await storage.listChildDirectories("movie_root");
    const movieDir = movieDirs.find((dir) => dir.name === "Some Film (2025) {tmdb-11}");
    expect(movieDir).toBeDefined();
    const tree = await storage.listTree({ directoryId: movieDir!.id });
    expect(tree.map((file) => file.path)).toEqual(["Some Film (2025).mkv"]);
  });

  it("movie reports no_coverage when no candidate exists", async () => {
    const result = await movieRun({ provider: emptyProvider() });
    expect(result.status).toBe("no_coverage");
    expect(result.episodes[0]!.obtained).toBe(false);
    expect(result.transferAttempts.length).toBe(0);
  });
});
