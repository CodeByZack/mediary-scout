import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { buildConsumptionContext, type ConsumptionDeps } from "../src/consumption/context.js";
import { consumeClaimedRun } from "../src/consumption/pipeline.js";
import type { PersistedWorkflowRunSnapshot } from "../src/repository.js";
import { FakeStorageExecutor } from "../src/fakes.js";
import { InMemoryWorkflowRepository } from "../src/repository.js";
import type { MediaTitle, ResourceCandidate, ResourceSnapshot, TrackedSeason } from "../src/domain.js";
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

function candidate(id: string, index: number, title: string): ResourceCandidate {
  return {
    id,
    snapshotId: "snap_two",
    index,
    title,
    type: "115",
    source: "pansou",
    providerPayload: {},
  };
}

/** Two B-grade candidates (no episode evidence) → no A → the selection
 *  arbitrator runs (the only point the fast path may touch the LLM). */
function twoCandidatesProvider(): ResourceProvider {
  return {
    search: async ({ keyword }): Promise<ResourceSnapshot> => ({
      id: "snap_two",
      provider: "pansou",
      keyword,
      candidates: [
        candidate("c1", 0, "示例剧.1080p"),
        candidate("c2", 1, "示例剧 高清"),
      ],
      createdAt: "2026-06-15T00:00:00.000Z",
    }),
  };
}

/** A model that THROWS on its first call — stands in for an LLM/API crash at
 *  the fast path's single escalation point (the selection arbitrator). */
function crashingModel() {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      throw new Error("simulated model/API crash mid-run");
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
  } as unknown as TrackedSeason;
}

const RUN_ID = "run-x";
const STARTED_AT = "2026-06-15T00:00:00.000Z";

/** 合成认领快照（步骤⑥ 后测试直调 pipeline，等价取代旧 runner 包装入口）。 */
function fakeClaimed(): PersistedWorkflowRunSnapshot {
  const season = trackedSeason();
  return {
    accountId: "acct_default",
    connectedStorageId: null,
    title: tvTitle,
    season,
    episodes: [],
    workflowRun: {
      id: RUN_ID,
      kind: "type2_init",
      status: "running",
      trackedSeasonId: season.id,
      startedAt: STARTED_AT,
      finishedAt: null,
      auditEvents: [],
    },
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [],
    obtainedEpisodes: [],
    providerAheadEpisodes: [],
  };
}

function ctxFor(repository: InMemoryWorkflowRepository, resourceProvider: ResourceProvider) {
  const deps: ConsumptionDeps = {
    repository,
    resourceProvider,
    storage: new FakeStorageExecutor(),
    model: crashingModel(),
    storageProvider: undefined,
    preferredLanguage: undefined,
    qualityPreference: undefined,
    assrtToken: undefined,
    tvParentDirectoryId: "tv_root",
    animeParentDirectoryId: undefined,
    moviesParentDirectoryId: undefined,
  };
  return buildConsumptionContext({
    kind: "type2_init",
    claimed: fakeClaimed(),
    deps,
  });
}

describe("agent trace — consumption pipeline wires the durable run record", () => {
  it("persists a reviewable no-coverage record (snapshot + resource evidence + notification), zero LLM", async () => {
    const repository = new InMemoryWorkflowRepository();
    const outcome = await consumeClaimedRun(ctxFor(repository, emptyProvider()));

    // Fast path: empty raw snapshot → honest no-coverage, run completes normally.
    expect(outcome.workflowStatus).toBe("no_coverage");
    const snapshot = await repository.getWorkflowRunSnapshot(RUN_ID);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.workflowRun.status).toBe("no_coverage");
    // The search evidence is persisted (provider + keyword are复盘-able).
    expect(snapshot!.resourceSnapshots).toHaveLength(1);
    expect(snapshot!.resourceSnapshots[0]!.provider).toBe("pansou");
    expect(snapshot!.resourceSnapshots[0]!.keyword).toBe("示例剧");
    // The no-coverage notification is persisted.
    expect(snapshot!.notifications.some((n) => n.kind === "no_coverage")).toBe(true);
  });

  it("crash-safe: an arbitrator crash rejects the run and never persists a fake snapshot", async () => {
    const repository = new InMemoryWorkflowRepository();
    // Two B-grade candidates → no A → the selection arbitrator runs,
    // and ITS model call throws mid-run.
    await expect(
      consumeClaimedRun(ctxFor(repository, twoCandidatesProvider())),
    ).rejects.toThrow();

    // Persist runs AFTER the acquisition awaits, so a mid-run crash skips it entirely.
    expect(await repository.getWorkflowRunSnapshot(RUN_ID)).toBeNull();
  });
});
