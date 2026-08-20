import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { runType2InitializationV2AndPersist } from "../src/runner-v2.js";
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

/** Two A-grade candidates → the grader has NO unique top → the selection
 *  arbitrator runs (the only point the fast path may touch the LLM). */
function twoCandidatesProvider(): ResourceProvider {
  return {
    search: async ({ keyword }): Promise<ResourceSnapshot> => ({
      id: "snap_two",
      provider: "pansou",
      keyword,
      candidates: [
        candidate("c1", 0, "示例剧.S01E01.1080p.中字"),
        candidate("c2", 1, "示例剧.S01E02.1080p.中字"),
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

const workflowRun = { id: "run-x", startedAt: "2026-06-15T00:00:00.000Z", finishedAt: "2026-06-15T00:01:00.000Z" };

describe("agent trace — runner-v2 wires the durable run record", () => {
  it("persists a reviewable no-coverage record (snapshot + resource evidence + notification), zero LLM", async () => {
    const repository = new InMemoryWorkflowRepository();
    const result = await runType2InitializationV2AndPersist({
      title: tvTitle,
      season: trackedSeason(),
      categoryParentId: "tv_root",
      resourceProvider: emptyProvider(),
      storage: new FakeStorageExecutor(),
      model: crashingModel(), // the no-candidate path must never touch the LLM
      repository,
      workflowRun,
    });

    // Fast path: empty raw snapshot → honest no-coverage, run completes normally.
    expect(result.status).toBe("no_coverage");
    const snapshot = await repository.getWorkflowRunSnapshot("run-x");
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
    // Two A-grade candidates → no unique top → the selection arbitrator runs,
    // and ITS model call throws mid-run.
    await expect(
      runType2InitializationV2AndPersist({
        title: tvTitle,
        season: trackedSeason(),
        categoryParentId: "tv_root",
        resourceProvider: twoCandidatesProvider(),
        storage: new FakeStorageExecutor(),
        model: crashingModel(),
        repository,
        workflowRun,
      }),
    ).rejects.toThrow();

    // Persist runs AFTER the acquisition awaits, so a mid-run crash skips it entirely.
    expect(await repository.getWorkflowRunSnapshot("run-x")).toBeNull();
  });
});
