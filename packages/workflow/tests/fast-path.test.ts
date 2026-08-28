import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { TaskSandbox } from "../src/acquisition-v2/sandbox.js";
import { FakeResourceProviderV2 } from "../src/acquisition-v2/fake-provider.js";
import { Storage115Simulator } from "../src/acquisition-v2/storage-115-simulator.js";
import { runFastPathAcquisition } from "../src/consumption/fast-path/tv.js";
import { makeAgentTraceSink } from "../src/acquisition-v2/agent-trace-sink.js";
import { InMemoryWorkflowRepository } from "../src/index.js";
import type { TvAnimeTarget } from "../src/acquisition-v2/task-agents.js";

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
      throw new Error("MODEL_SHOULD_NOT_BE_CALLED: fast path must stay zero-LLM");
    },
  });
}

/** Model returning a scripted sequence of texts, one per doGenerate call. */
function sequentialModel(texts: string[]) {
  let i = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text" as const, text: texts[i++] ?? texts[texts.length - 1]! }],
      finishReason: { unified: "stop" as const, raw: "stop" as const },
      usage: USAGE,
      warnings: [],
    }),
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
  /** Target seasons (default [1]); drives which season dirs exist. */
  seasons?: number[];
  /** Title for the canonical name (default 狂飙). */
  title?: string;
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
  const seasons = options.seasons ?? [1];
  const seasonDirIds: Record<number, string> = {};
  for (const s of seasons) {
    seasonDirIds[s] = await storage.createDirectory({ name: `Season ${s}`, parentId: "root" });
  }
  const sandbox = new TaskSandbox({
    provider,
    storage,
    stagingDirectoryId,
    targetSeasonDirectoryIds: seasonDirIds,
    need: options.need ?? ["S01E01"],
    canonicalTitle: options.title ?? "狂飙",
    titleTerms: options.title ? [options.title] : ["狂飙"],
  });
  await sandbox.primeRawSnapshot("狂飙");
  return { sandbox, storage, seasonDirIds, s1: seasonDirIds[1]! };
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

  it("bugfix 2026-08-21: diagnostic accept on an AI-mapped fansub pack keeps the mapped episode (S03)", async () => {
    // 末日地堡 S03 缺 S08:包是 fansub 风格 `末日地堡 - 08.mkv`(文件名夹标题,
    // 纯数字规则不适用,代码解析不出),AI 集数映射确认 08.mkv → S03E08,
    // 01.mkv 也无法解析(留在 unmapped) → 仍脏 → 诊断仲裁 accept。修复前
    // accept 分支的 finalizeLanding 漏传 overrides,08.mkv 会随 staging wipe
    // 被清掉(假入库);修复后 08.mkv 必须 rename+归位入库,仅 01.mkv 被丢弃。
    const { sandbox, storage, seasonDirIds } = await createSetup({
      candidates: [{ id: "c1", title: "末日地堡 第三季 [8集] 全" }],
      seasons: [3],
      need: ["S03E08"],
      title: "末日地堡",
      packs: {
        c1: {
          files: [
            { path: "末日地堡 - 01.mkv", sizeBytes: 1_000_000_000 },
            { path: "末日地堡 - 08.mkv", sizeBytes: 1_000_000_000 },
          ],
        },
      },
    });
    const s3 = seasonDirIds[3]!;

    const result = await runFastPathAcquisition({
      sandbox,
      // 第一次:集数映射只给 08.mkv → S03E08(01.mkv 留 unmapped → 仍脏 → 回落诊断)。
      // 第二次:诊断仲裁 accept。
      model: sequentialModel([
        '{"mapping":{"末日地堡 - 08.mkv":"S03E08"},"unmapped":["末日地堡 - 01.mkv"],"reasoning":"编号 08 是第 8 集"}',
        '{"action":"accept","reasoning":"核心集数 S03E08 已存在,额外 01.mkv 不影响"}',
      ]),
      target: { ...target, title: "末日地堡", seasons: [3], missingEpisodes: ["S03E08"] },
      isChineseNative: false,
    });

    expect(result.escalated).toBe(true);
    expect(result.coverage.coverageMet).toBe(true);
    expect(result.coverage.obtained).toContain("S03E08");
    // 修复后 08.mkv 被 rename 成 末日地堡.S03E08.mkv 并归位到 Season 3;01.mkv 留在 staging 被 wipe。
    expect((await storage.listTree({ directoryId: s3 })).map((f) => f.path)).toEqual([
      "末日地堡.S03E08.mkv",
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

  it("dead links do NOT consume transfer attempts — scans past 3 dead links to the live candidate", async () => {
    const { sandbox, s1, storage } = await createSetup({
      candidates: [
        { id: "c1", title: "狂飙.S01E01.1080p.中字" },
        { id: "c2", title: "狂飙.S01E01.1080p.中字" },
        { id: "c3", title: "狂飙.S01E01.1080p.中字" },
        { id: "c4", title: "狂飙.S01E01.1080p.中字" },
      ],
      packs: { c4: { files: [{ path: "狂飙.S01E01.mkv", sizeBytes: 1_000_000_000 }] } },
      failureMessages: { c1: "dead share", c2: "dead share", c3: "dead share" },
    });

    // 4 A-grades → arbitrator picks c1; c1/c2/c3 are dead links (cheap probes,
    // NOT counted against MAX_TRANSFER_ATTEMPTS), c4 lands — exactly ONE real
    // transfer attempt. (Old behaviour: 3 dead links burned the whole budget.)
    const result = await runFastPathAcquisition({
      sandbox,
      model: textModel('{"candidateId":"c1","reasoning":"选第一个"}'),
      target,
      isChineseNative: false,
    });

    expect(result.coverage.coverageMet).toBe(true);
    expect(result.coverage.obtained).toEqual(["S01E01"]);
    expect(result.steps).toBe(1);
    expect((await storage.listTree({ directoryId: s1 })).map((f) => f.path)).toEqual([
      "狂飙.S01E01.mkv",
    ]);
  });

  it("stops the dead-link scan at MAX_DEAD_LINK_RETRIES with zero real transfers", async () => {
    const candidates = Array.from({ length: 11 }, (_, i) => ({
      id: `c${i + 1}`,
      title: "狂飙.S01E01.1080p.中字",
    }));
    const failureMessages = Object.fromEntries(candidates.map((c) => [c.id, "dead share"]));
    const { sandbox } = await createSetup({ candidates, packs: {}, failureMessages });

    // 11 A-grade dead links → arbitrator picks c1; the scan hits the dead-link
    // retry cap (10) and gives up — still zero real transfers.
    const result = await runFastPathAcquisition({
      sandbox,
      model: textModel('{"candidateId":"c1","reasoning":"选第一个"}'),
      target,
      isChineseNative: false,
    });

    expect(result.coverage.coverageMet).toBe(false);
    expect(result.coverage.missing).toEqual(["S01E01"]);
    expect(result.steps).toBe(0); // 全是死链：死链不占转存次数
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

  it("兜底全失败且 primary 有候选 → 恢复 primary 快照继续仲裁(不判暂无资源)(狂飙实证)", async () => {
    const { sandbox, s1, storage, aliasTarget, searches } = await createAliasSetup({
      results: {
        狂飙: [
          { id: "c1", title: "狂飙.S01E01.1080p.中字" },
          { id: "c2", title: "狂飙.S01E02.1080p.中字" },
        ], // 两个同题 A → 无唯一 top → 触发兜底
        "The Knockout": [], // 兜底命中 0 → 旧行为:最后一个兜底快照为空覆盖 primary → 误报「暂无资源(快照为空)」
      },
      packs: { c1: { files: [{ path: "狂飙.S01E01.mkv", sizeBytes: 1 }] } },
      aliases: ["The Knockout"],
    });

    const result = await runFastPathAcquisition({
      sandbox,
      model: textModel('{"candidateId":"c1","reasoning":"primary 候选"}'),
      target: aliasTarget,
      isChineseNative: false,
    });

    expect(result.escalated).toBe(true); // 回到 primary 走仲裁(而非直接放弃)
    expect(result.coverage.coverageMet).toBe(true); // 不是「暂无资源(快照为空)」
    expect((await storage.listTree({ directoryId: s1 })).map((f) => f.path)).toEqual([
      "狂飙.S01E01.mkv",
    ]);
    expect(searches.length).toBe(2); // 1 primary + 1 兜底;恢复 primary 零额外搜索
  });
});

describe("runFastPathAcquisition — 步骤写入 agent_steps（Task D）", () => {
  it("成功转存路径:每步写一条 AgentStep(落点检查→预搜→评分→选片→转存→digest→归位→结论)", async () => {
    const repo = new InMemoryWorkflowRepository();
    const trace = makeAgentTraceSink({ repository: repo, workflowRunId: "run-fp-d1" });
    const { sandbox, s1, storage } = await createSetup({
      candidates: [{ id: "c1", title: "狂飙.S01E01.1080p.中字" }],
      packs: { c1: { files: [{ path: "狂飙.S01E01.mkv", sizeBytes: 1 }] } },
    });

    const result = await runFastPathAcquisition({
      sandbox,
      model: throwModel(),
      target,
      isChineseNative: false,
      onProgress: trace,
    });

    expect(result.coverage.coverageMet).toBe(true);
    await tick();
    const steps = await repo.listAgentSteps("run-fp-d1");
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
    // 序号连续;activity = stepLog 的 detail;转存带 candidateId 参数
    expect(steps.map((s) => s.ordinal)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(steps[1]!.activity).toBe("候选 1 条");
    expect(steps[4]!.args.candidateId).toBe("c1");
    expect(steps[7]!.activity).toContain("入库");
    // 落盘结果不受 trace 影响
    expect((await storage.listTree({ directoryId: s1 })).map((f) => f.path)).toEqual([
      "狂飙.S01E01.mkv",
    ]);
  });

  it("已在库路径:写 markObtained(mark 阶段)+ 结论步骤", async () => {
    const repo = new InMemoryWorkflowRepository();
    const trace = makeAgentTraceSink({ repository: repo, workflowRunId: "run-fp-d2" });
    const provider = new FakeResourceProviderV2({ results: { 狂飙: [] } });
    const storage = new Storage115Simulator({ packs: {} });
    const stagingDirectoryId = await storage.createDirectory({ name: "staging", parentId: "root" });
    const s1 = await storage.createDirectory({ name: "Season 1", parentId: "root" });
    // Place an episode directly on disk (already-on-disk §6b#8 scenario).
    await storage.transferSubtitleUrl({
      url: "http://x/狂飙.S01E01.mkv",
      filename: "狂飙.S01E01.mkv",
      intoDirectoryId: s1,
    });
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
      onProgress: trace,
    });

    expect(result.coverage.coverageMet).toBe(true);
    await tick();
    const steps = await repo.listAgentSteps("run-fp-d2");
    expect(steps.map((s) => s.toolName)).toEqual(["inspectTargetDir", "markObtained", "finish"]);
    expect(steps.map((s) => s.phase)).toEqual(["search", "mark", "finalize"]);
    expect(steps[1]!.args.codes).toEqual(["S01E01"]);
  });

  it("无候选路径:写 reportNoCoverage 结论步骤(写失败静默,不崩溃)", async () => {
    const repo = new InMemoryWorkflowRepository();
    const trace = makeAgentTraceSink({ repository: repo, workflowRunId: "run-fp-d3" });
    const { sandbox } = await createSetup({ candidates: [], packs: {} });

    const result = await runFastPathAcquisition({
      sandbox,
      model: throwModel(),
      target,
      isChineseNative: false,
      onProgress: trace,
    });

    expect(result.coverage.coverageMet).toBe(false);
    await tick();
    const steps = await repo.listAgentSteps("run-fp-d3");
    expect(steps.map((s) => s.toolName)).toEqual([
      "inspectTargetDir",
      "viewResourceSnapshot",
      "reportNoCoverage",
    ]);
    expect(steps[2]!.activity).toBe("暂无资源(快照为空)");
  });

  it("onProgress 缺失(裸 sandbox)→ 不写 trace 也不崩溃", async () => {
    const { sandbox, storage, s1 } = await createSetup({
      candidates: [{ id: "c1", title: "狂飙.S01E01.1080p.中字" }],
      packs: { c1: { files: [{ path: "狂飙.S01E01.mkv", sizeBytes: 1 }] } },
    });

    const result = await runFastPathAcquisition({
      sandbox,
      model: throwModel(),
      target,
      isChineseNative: false,
    });

    expect(result.coverage.coverageMet).toBe(true);
    expect((await storage.listTree({ directoryId: s1 })).map((f) => f.path)).toEqual([
      "狂飙.S01E01.mkv",
    ]);
  });
});
