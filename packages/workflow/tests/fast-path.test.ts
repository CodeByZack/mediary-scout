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
  qualityPreference: "1080p",
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
  /** Additional keyword → candidates for the alias 兜底重搜 rounds. */
  extraResults?: Record<string, Array<{ id: string; title: string }>>;
  /** Counts every provider.search call (primary prime + fallback rounds). */
  onSearch?: () => void;
}

async function createSetup(options: SetupOptions) {
  const provider = new FakeResourceProviderV2({
    results: { 狂飙: options.candidates, ...options.extraResults },
    ...(options.onSearch ? { onSearch: options.onSearch } : {}),
  });
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

  it("gracefully reports no_coverage when the arbitrator returns a TITLE as candidateId (the 狂飙 bug)", async () => {
    // Two same-title A-grades → no unique top → arbitrator sees only the graded
    // summary and (the bug) fills the TITLE back as candidateId. The guard must
    // catch it and conclude uncovered — transferCandidate must never throw
    // SANDBOX_CANDIDATE_NOT_IN_SNAPSHOT and kill the whole run.
    const { sandbox } = await createSetup({
      candidates: [
        { id: "c1", title: "狂飙.S01E01.1080p.中字" },
        { id: "c2", title: "狂飙.S01E02.1080p.中字" },
      ],
      packs: {},
    });

    const result = await runFastPathAcquisition({
      sandbox,
      model: textModel('{"candidateId":"狂飙","reasoning":"选狂飙"}'),
      target,
      isChineseNative: false,
    });

    expect(result.escalated).toBe(true);
    expect(result.coverage.coverageMet).toBe(false);
    expect(result.coverage.missing).toEqual(["S01E01"]);
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

  it("空快照时用 aliases 兜底重搜，命中唯一 A 直接盲转（零 LLM）", async () => {
    let searches = 0;
    const fallbackTarget: TvAnimeTarget = {
      ...target,
      aliases: ["The Knockout"], // 狂飙 的英文原名，优先于其它译名
    };
    const { sandbox, s1, storage } = await createSetup({
      candidates: [], // title 预搜落空 → 触发兜底
      extraResults: {
        "the knockout": [{ id: "c1", title: "The Knockout.S01E01.1080p.中字" }],
      },
      packs: { c1: { files: [{ path: "The Knockout.S01E01.mkv", sizeBytes: 1_000_000_000 }] } },
      onSearch: () => {
        searches += 1;
      },
    });

    const result = await runFastPathAcquisition({
      sandbox,
      model: throwModel(),
      target: fallbackTarget,
      isChineseNative: false,
    });

    expect(result.escalated).toBe(false);
    expect(result.coverage.coverageMet).toBe(true);
    expect(result.coverage.obtained).toEqual(["S01E01"]);
    expect(searches).toBe(2); // 1 预搜 + 1 兜底（唯一 A 提前停）
    // 兜底命中的候选被 canonical 重命名后归位（前缀是 canonicalTitle 狂飙）。
    expect((await storage.listTree({ directoryId: s1 })).map((f) => f.path)).toEqual([
      "狂飙.S01E01.mkv",
    ]);
  });

  it("标题搜索无唯一 A（两个 A 平级）时用 aliases 兜底，命中唯一 A 直接盲转", async () => {
    let searches = 0;
    const fallbackTarget: TvAnimeTarget = {
      ...target,
      aliases: ["The Knockout"],
    };
    const { sandbox, s1, storage } = await createSetup({
      candidates: [
        { id: "c1", title: "狂飙.S01E01.1080p.中字" },
        { id: "c2", title: "狂飙.S01E02.1080p.中字" }, // 两个 A → 无唯一 top → 触发兜底
      ],
      extraResults: {
        "the knockout": [{ id: "c3", title: "The Knockout.S01E01.1080p.中字" }],
      },
      packs: { c3: { files: [{ path: "The Knockout.S01E01.mkv", sizeBytes: 1_000_000_000 }] } },
      onSearch: () => {
        searches += 1;
      },
    });

    const result = await runFastPathAcquisition({
      sandbox,
      model: throwModel(),
      target: fallbackTarget,
      isChineseNative: false,
    });

    expect(result.escalated).toBe(false); // 兜底命中唯一 A → 不再仲裁，零 LLM
    expect(result.coverage.coverageMet).toBe(true);
    expect(result.coverage.obtained).toEqual(["S01E01"]);
    expect(searches).toBe(2);
    expect((await storage.listTree({ directoryId: s1 })).map((f) => f.path)).toEqual([
      "狂飙.S01E01.mkv",
    ]);
  });

  it("兜底重搜预算 ≤3 轮：alias 再多也只搜 3 次，不锤爆配额", async () => {
    let searches = 0;
    const fallbackTarget: TvAnimeTarget = {
      ...target,
      aliases: ["Alias A", "Alias B", "Alias C", "Alias D"], // 4 个别名，预算只放行 3 个
    };
    const { sandbox } = await createSetup({
      candidates: [], // title 预搜落空 → 触发兜底
      extraResults: {
        "alias a": [],
        "alias b": [],
        "alias c": [],
        "alias d": [], // 预算内永远不会搜到它
      },
      packs: {},
      onSearch: () => {
        searches += 1;
      },
    });

    const result = await runFastPathAcquisition({
      sandbox,
      model: throwModel(),
      target: fallbackTarget,
      isChineseNative: false,
    });

    expect(searches).toBe(4); // 1 预搜 + 3 兜底（MAX_FALLBACK_SEARCHES 上限）
    expect(result.coverage.coverageMet).toBe(false); // 全部落空 → 诚实 no_coverage
    expect(result.coverage.missing).toEqual(["S01E01"]);
  });

  it("aliases 为空时不兜底：行为与一次搜索直接走原逻辑完全一致", async () => {
    let searches = 0;
    const { sandbox } = await createSetup({
      candidates: [], // 空快照
      packs: {},
      onSearch: () => {
        searches += 1;
      },
    });

    const result = await runFastPathAcquisition({
      sandbox,
      model: throwModel(),
      target, // 模块级 target 的 aliases 就是 []
      isChineseNative: false,
    });

    expect(searches).toBe(1); // 只有预搜，无任何兜底搜索
    expect(result.coverage.coverageMet).toBe(false);
    expect(result.coverage.missing).toEqual(["S01E01"]);
  });
});

describe("runFastPathAcquisition — §C aliases 兜底重搜", () => {
  /** C-specific setup: per-keyword results + target aliases + search counter.
   *  primeRawSnapshot("狂飙") = the orchestrator pre-warm (search #1). */
  async function createAliasSetup(options: {
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
    const aliasTarget: TvAnimeTarget = {
      title: "狂飙",
      aliases: options.aliases,
      seasons: [1],
      missingEpisodes: ["S01E01"],
      qualityPreference: "1080p",
    };
    return { sandbox, storage, s1, aliasTarget, searches };
  }

  it("兜底:primary 空快照 + alias 命中唯一 A → 直接转存(零 LLM)", async () => {
    const { sandbox, s1, storage, aliasTarget, searches } = await createAliasSetup({
      results: {
        狂飙: [], // primary title → 0 候选
        "Ted Lasso": [], // 英文原名 → 0 候选
        足球教练: [{ id: "c1", title: "狂飙.S01E01.1080p.中字" }], // 译名 → 唯一 A
      },
      packs: { c1: { files: [{ path: "狂飙.S01E01.mkv", sizeBytes: 1 }] } },
      aliases: ["Ted Lasso", "足球教练"], // 英文原名在前,译名在后(aliasList 顺序)
    });

    const result = await runFastPathAcquisition({
      sandbox,
      model: throwModel(),
      target: aliasTarget,
      isChineseNative: false,
    });

    expect(result.escalated).toBe(false);
    expect(result.coverage.coverageMet).toBe(true);
    expect(result.coverage.obtained).toEqual(["S01E01"]);
    expect((await storage.listTree({ directoryId: s1 })).map((f) => f.path)).toEqual([
      "狂飙.S01E01.mkv",
    ]);
    // 1 primary + 2 alias rounds(英文原名 0 命中后继续),仍在 ≤3 预算内。
    expect(searches.length).toBe(3);
  });

  it("兜底:primary 无唯一 A + alias 命中唯一 A → 直接转存(零 LLM)", async () => {
    const { sandbox, s1, storage, aliasTarget, searches } = await createAliasSetup({
      results: {
        狂飙: [
          { id: "c1", title: "狂飙.S01E01.1080p.中字" },
          { id: "c2", title: "狂飙.S01E02.1080p.中字" },
        ], // 两个同题 A → 无唯一 top → 触发兜底
        足球教练: [{ id: "c3", title: "狂飙.S01E01.1080p.中字" }], // 译名 → 唯一 A
      },
      packs: { c3: { files: [{ path: "狂飙.S01E01.mkv", sizeBytes: 1 }] } },
      aliases: ["足球教练"],
    });

    const result = await runFastPathAcquisition({
      sandbox,
      model: throwModel(),
      target: aliasTarget,
      isChineseNative: false,
    });

    expect(result.escalated).toBe(false);
    expect(result.coverage.coverageMet).toBe(true);
    expect(result.coverage.obtained).toEqual(["S01E01"]);
    expect(searches.length).toBe(2); // 1 primary + 1 alias
  });

  it("兜底预算 ≤3:只重搜 3 个 alias,仲裁基于最后一个快照", async () => {
    const { sandbox, s1, storage, aliasTarget, searches } = await createAliasSetup({
      results: {
        狂飙: [],
        A1: [
          { id: "a1", title: "狂飙.S01E01.1080p.中字" },
          { id: "a1b", title: "狂飙.S01E02.1080p.中字" },
        ],
        A2: [
          { id: "a2", title: "狂飙.S01E01.1080p.中字" },
          { id: "a2b", title: "狂飙.S01E02.1080p.中字" },
        ],
        A3: [
          { id: "a3", title: "狂飙.S01E01.1080p.中字" },
          { id: "a3b", title: "狂飙.S01E02.1080p.中字" },
        ],
        A4: [
          { id: "a4", title: "狂飙.S01E01.1080p.中字" },
          { id: "a4b", title: "狂飙.S01E02.1080p.中字" },
        ],
      },
      packs: { a3: { files: [{ path: "狂飙.S01E01.mkv", sizeBytes: 1 }] } },
      aliases: ["A1", "A2", "A3", "A4"],
    });

    const result = await runFastPathAcquisition({
      sandbox,
      model: textModel('{"candidateId":"a3","reasoning":"最后一个快照"}'),
      target: aliasTarget,
      isChineseNative: false,
    });

    expect(result.escalated).toBe(true);
    expect(result.coverage.coverageMet).toBe(true);
    // a3 只存在于 A3 快照:若仲裁用的是更早的快照,a3 不在候选内会被判非法候选
    // 而放弃(no_coverage)——能转存成功即证明仲裁读的是最后一个快照。
    expect((await storage.listTree({ directoryId: s1 })).map((f) => f.path)).toEqual([
      "狂飙.S01E01.mkv",
    ]);
    // 1 primary + 3 budget-capped fallback(A4 未搜)。
    expect(searches.length).toBe(4);
  });

  it("兜底:primary 唯一 A 且存在 aliases → 不触发兜底(1 次搜索)", async () => {
    const { sandbox, s1, storage, aliasTarget, searches } = await createAliasSetup({
      results: {
        狂飙: [{ id: "c1", title: "狂飙.S01E01.1080p.中字" }],
        足球教练: [{ id: "c9", title: "狂飙.S01E01.1080p.中字" }],
      },
      packs: { c1: { files: [{ path: "狂飙.S01E01.mkv", sizeBytes: 1 }] } },
      aliases: ["足球教练"],
    });

    const result = await runFastPathAcquisition({
      sandbox,
      model: throwModel(),
      target: aliasTarget,
      isChineseNative: false,
    });

    expect(result.escalated).toBe(false);
    expect(result.coverage.coverageMet).toBe(true);
    expect(searches.length).toBe(1); // alias 未被搜
  });

  it("兜底:aliases 为空 → 行为与原来完全一致(空快照 1 次搜索即放弃)", async () => {
    const { sandbox, aliasTarget, searches } = await createAliasSetup({
      results: { 狂飙: [] },
      packs: {},
      aliases: [],
    });

    const result = await runFastPathAcquisition({
      sandbox,
      model: throwModel(),
      target: aliasTarget,
      isChineseNative: false,
    });

    expect(result.coverage.coverageMet).toBe(false);
    expect(result.escalated).toBe(false);
    expect(searches.length).toBe(1); // 无兜底
  });

  it("兜底:alias 搜索源故障 → 跳过该轮继续下一 alias(不崩溃)", async () => {
    const { sandbox, s1, storage, aliasTarget, searches } = await createAliasSetup({
      results: {
        狂飙: [],
        泰德·拉索: [{ id: "c1", title: "狂飙.S01E01.1080p.中字" }],
      },
      errorKeywords: ["足球教练"],
      packs: { c1: { files: [{ path: "狂飙.S01E01.mkv", sizeBytes: 1 }] } },
      aliases: ["足球教练", "泰德·拉索"],
    });

    const result = await runFastPathAcquisition({
      sandbox,
      model: throwModel(),
      target: aliasTarget,
      isChineseNative: false,
    });

    expect(result.escalated).toBe(false);
    expect(result.coverage.coverageMet).toBe(true);
    expect(searches.length).toBe(3); // primary + 失败轮 + 成功轮
  });
});
