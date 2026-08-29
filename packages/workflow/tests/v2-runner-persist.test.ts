import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import {
  buildConsumptionContext,
  buildPatrolConsumptionContext,
  type ConsumptionDeps,
} from "../src/consumption/context.js";
import { consumeClaimedRun } from "../src/consumption/pipeline.js";
import type { PersistedWorkflowRunSnapshot, WorkflowRepository } from "../src/repository.js";
import { InMemoryWorkflowRepository } from "../src/repository.js";
import { FakeStorageExecutor } from "../src/fakes.js";
import {
  createEpisodeStates,
  type AuditEvent,
  type EpisodeState,
  type MediaTitle,
  type ResourceSnapshot,
  type TrackedSeason,
  type WorkflowKind,
} from "../src/domain.js";
import type { ResourceProvider } from "../src/ports.js";

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
      createdAt: "2026-06-15T00:00:00.000Z",
    }),
  };
}

function searchThenReportModel() {
  let i = 0;
  const tool = (name: string, input: unknown) => ({
    content: [{ type: "tool-call" as const, toolCallId: `c${i}`, toolName: name, input: JSON.stringify(input) }],
    finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const },
    usage: USAGE,
    warnings: [],
  });
  return new MockLanguageModelV3({
    doGenerate: async () => {
      i += 1;
      if (i === 1) return tool("searchResources", { keyword: "show" });
      if (i === 2) return tool("reportNoCoverage", { reason: "no candidates" });
      return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" as const }, usage: USAGE, warnings: [] };
    },
  });
}

const tvTitle = {
  id: "tmdb_tv_100",
  tmdbId: 100,
  type: "tv",
  title: "示例剧",
  year: 2024,
  aliases: ["Example Show"],
} as unknown as MediaTitle;

const movieTitle = {
  id: "tmdb_movie_27205",
  tmdbId: 27205,
  type: "movie",
  title: "盗梦空间",
  year: 2010,
  aliases: ["Inception"],
} as unknown as MediaTitle;

function trackedSeason(): TrackedSeason {
  return {
    id: "tmdb_tv_100_s1",
    mediaTitleId: "tmdb_tv_100",
    seasonNumber: 1,
    status: "active",
    qualityPreference: "4K",
    storageDirectoryId: "",
    totalEpisodes: 3,
    latestAiredEpisode: 3,
    latestAiredSource: "metadata",
  };
}

const RUN_ID = "run-x";
const STARTED_AT = "2026-06-15T00:00:00.000Z";

/** 合成认领快照（步骤⑥ 后测试直调 pipeline，等价取代旧 runner 包装入口）。 */
function fakeClaimed(overrides: {
  kind: WorkflowKind;
  title: MediaTitle;
  season: TrackedSeason;
  episodes?: EpisodeState[];
  auditEvents?: AuditEvent[];
}): PersistedWorkflowRunSnapshot {
  return {
    accountId: "acct_default",
    connectedStorageId: null,
    title: overrides.title,
    season: overrides.season,
    episodes: overrides.episodes ?? [],
    workflowRun: {
      id: RUN_ID,
      kind: overrides.kind,
      status: "running",
      trackedSeasonId: overrides.season.id,
      startedAt: STARTED_AT,
      finishedAt: null,
      auditEvents: overrides.auditEvents ?? [],
    },
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [],
    obtainedEpisodes: [],
    providerAheadEpisodes: [],
  };
}

function depsFor(
  repository: WorkflowRepository,
  over: Partial<ConsumptionDeps> = {},
): ConsumptionDeps {
  return {
    repository,
    resourceProvider: emptyProvider(),
    storage: new FakeStorageExecutor(),
    model: searchThenReportModel(),
    storageProvider: undefined,
    preferredLanguage: undefined,
    qualityPreference: undefined,
    assrtToken: undefined,
    tvParentDirectoryId: undefined,
    animeParentDirectoryId: undefined,
    moviesParentDirectoryId: undefined,
    ...over,
  };
}

describe("consumption pipeline persist — V2 engine results persisted in the existing record shapes", () => {
  it("type2 init: persists one type2_init snapshot with the tracked season and episodes", async () => {
    const repository = new InMemoryWorkflowRepository();
    const ctx = buildConsumptionContext({
      kind: "type2_init",
      claimed: fakeClaimed({ kind: "type2_init", title: tvTitle, season: trackedSeason() }),
      deps: depsFor(repository, { tvParentDirectoryId: "tv_root" }),
    });
    const outcome = await consumeClaimedRun(ctx);

    expect(outcome.workflowStatus).toBe("no_coverage");
    const snapshot = await repository.getWorkflowRunSnapshot(RUN_ID);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.workflowRun.kind).toBe("type2_init");
    expect(snapshot!.workflowRun.trackedSeasonId).toBe("tmdb_tv_100_s1");
    expect(snapshot!.episodes).toHaveLength(3);
    const tracked = await repository.listTrackedSeasonStates();
    expect(tracked.map((state) => state.season.id)).toContain("tmdb_tv_100_s1");
  });

  it("type3 patrol: persists a type3_monitor snapshot, scheduled-trigger notification", async () => {
    const repository = new InMemoryWorkflowRepository();
    const ctx = buildPatrolConsumptionContext({
      title: tvTitle,
      patrol: {
        runId: RUN_ID,
        startedAt: STARTED_AT,
        season: trackedSeason(),
        episodes: createEpisodeStates({ trackedSeasonId: "tmdb_tv_100_s1", seasonNumber: 1, totalEpisodes: 3, latestAiredEpisode: 3 }),
        accountId: "acct_default",
        connectedStorageId: null,
      },
      deps: depsFor(repository, { tvParentDirectoryId: "tv_root" }),
    });
    await consumeClaimedRun(ctx);

    const snapshot = await repository.getWorkflowRunSnapshot(RUN_ID);
    expect(snapshot!.workflowRun.kind).toBe("type3_monitor");
    const notifications = await repository.listNotifications();
    expect(notifications.some((notification) => notification.trigger === "scheduled")).toBe(true);
  });

  it("series init: persists one type1_package_init record per season under _s{n} ids", async () => {
    const repository = new InMemoryWorkflowRepository();
    const ctx = buildConsumptionContext({
      kind: "type1_package_init",
      claimed: fakeClaimed({
        kind: "type1_package_init",
        title: tvTitle,
        season: trackedSeason(),
        auditEvents: [
          {
            type: "series_init_queued",
            message: "Series initialization queued",
            data: {
              seasons: [
                { seasonNumber: 1, totalEpisodes: 3, latestAiredEpisode: 3 },
                { seasonNumber: 2, totalEpisodes: 3, latestAiredEpisode: 3 },
              ],
            },
          },
        ],
      }),
      deps: depsFor(repository, { tvParentDirectoryId: "tv_root" }),
    });
    await consumeClaimedRun(ctx);

    const s1 = await repository.getWorkflowRunSnapshot(`${RUN_ID}_s1`);
    const s2 = await repository.getWorkflowRunSnapshot(`${RUN_ID}_s2`);
    expect(s1!.workflowRun.kind).toBe("type1_package_init");
    expect(s2!.workflowRun.kind).toBe("type1_package_init");
    // Resource evidence rides on the first season only.
    expect(s2!.resourceSnapshots).toEqual([]);
    const tracked = await repository.listTrackedSeasonStates();
    expect(tracked.map((state) => state.season.id).sort()).toEqual(["tmdb_tv_100_s1", "tmdb_tv_100_s2"]);
  });

  it("movie init: persists a movie_init snapshot via the V2 movie engine", async () => {
    const repository = new InMemoryWorkflowRepository();
    const ctx = buildConsumptionContext({
      kind: "movie_init",
      claimed: fakeClaimed({ kind: "movie_init", title: movieTitle, season: trackedSeason() }),
      deps: depsFor(repository, { moviesParentDirectoryId: "movies_root" }),
    });
    const outcome = await consumeClaimedRun(ctx);

    expect(outcome.workflowStatus).toBe("no_coverage");
    const snapshot = await repository.getWorkflowRunSnapshot(RUN_ID);
    expect(snapshot!.workflowRun.kind).toBe("movie_init");
  });
});
