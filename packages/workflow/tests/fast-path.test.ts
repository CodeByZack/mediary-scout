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
  candidates: Array<{ id: string; title: string; url?: string }>;
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
  /** TMDB 各集原始 name(SxxExx→"Episode N (Part X)")——综艺「第N期」Part 锚定/期号一致性校验数据。 */
  episodeNames?: Record<string, string>;
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
      // issue #29 回归:候选带 url → 转存步骤需透出 linkUrl(用户拍板链接展示)。
      candidates: [{ id: "c1", title: "狂飙.S01E01.1080p.中字", url: "https://115.com/s/abc123" }],
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
  it("2026-08-31 综艺「第N期」错位修复:代码解析不覆盖缺集时,把全部正片交 AI 重映射(第10期→S01E19)", async () => {
    // 地球超新鲜案:TMDB 一季拆多集、综艺每期 2 集(第1期=E01/E02 … 第10期=E19/E20),
    // 但代码把「第N期」机械解析成 S01EN(第10期上→S01E10,错)。缺集 S01E19 的
    // 「第10期上」被代码"成功"解析成 S01E10 → 旧逻辑无 unparsed 不触发 AI → 不覆盖 need → 整包放弃。
    // 修复后:代码解析未覆盖 need 时把全部正片交 AI,AI 据整季范围(播出日表 1..20)对齐出 S01E19。
    const { sandbox, storage, seasonDirIds } = await createSetup({
      candidates: [{ id: "c1", title: "地球超新鲜 全集 4K 中字" }],
      seasons: [1],
      need: ["S01E19"],
      title: "地球超新鲜",
      packs: {
        c1: {
          files: [
            { path: "2026.07.01_第1期上_4K.mp4", sizeBytes: 1_000_000_000 },
            { path: "2026.07.02_第1期下_4K.mp4", sizeBytes: 1_000_000_000 },
            { path: "2026.07.08_第2期上_4K.mp4", sizeBytes: 1_000_000_000 },
            { path: "2026.07.09_第2期下_4K.mp4", sizeBytes: 1_000_000_000 },
            { path: "2026.08.28_第10期上_4K.mp4", sizeBytes: 1_000_000_000 },
            { path: "2026.08.29_第10期下_4K.mp4", sizeBytes: 1_000_000_000 },
          ],
        },
      },
    });
    const s1 = seasonDirIds[1]!;

    // 唯一 A 盲转不耗 AI;转存后代码解析 E01..E10 不覆盖 E19 → 全量正片交 AI → AI 对齐。
    const seen: string[] = [];
    const result = await runFastPathAcquisition({
      sandbox,
      model: sequentialModel([
        '{"mapping":{"2026.08.28_第10期上_4K.mp4":"S01E19","2026.08.29_第10期下_4K.mp4":"S01E20"},"unmapped":[],"reasoning":"第10期上/下对应 TMDB S01E19/E20"}',
      ]),
      target: { ...target, title: "地球超新鲜", seasons: [1], missingEpisodes: ["S01E19"] },
      isChineseNative: false,
      onProgress: (event) => {
        if (event.toolName === "arbitrateEpisodeMapping") seen.push(event.activity ?? "");
      },
    });

    expect(result.coverage.coverageMet).toBe(true);
    expect(result.coverage.obtained).toContain("S01E19");
    // AI 映射确实被触发(代码解析未覆盖 need)。
    expect(seen.length).toBeGreaterThan(0);
  });
  it("2026-08-31 假集号防线:AI 把「第4期上」映射成 S02E19(期号不符)→ 拒绝,不假入库", async () => {
    // 地球超新鲜 s2:TMDB E19=Episode 10 (Part 1)。包里正片只到第4期(第4期上/下),
    // AI 全量重映射若无期号一致性校验,会把「第4期上」硬安成 S02E19(迎合缺集)→ 假入库。
    // 有 episodeNames 时校验反查:第4期 ≠ Episode 10 → 该映射作废 → 回落诊断仲裁。
    const { sandbox, storage, seasonDirIds } = await createSetup({
      candidates: [{ id: "c1", title: "地球超新鲜 全集 4K 中字" }],
      seasons: [1],
      need: ["S01E19"],
      title: "地球超新鲜",
      episodeNames: {
        S01E19: "Episode 10 (Part 1)",
        S01E20: "Episode 10 (Part 2)",
      },
      packs: {
        c1: {
          files: [
            { path: "2026.07.18_第4期上_4K.mp4", sizeBytes: 1_000_000_000 },
            { path: "2026.07.19_第4期下_4K.mp4", sizeBytes: 1_000_000_000 },
          ],
        },
      },
    });
    const result = await runFastPathAcquisition({
      sandbox,
      model: sequentialModel([
        '{"mapping":{"2026.07.18_第4期上_4K.mp4":"S01E19"},"unmapped":[],"reasoning":"第4期上映射到 E19"}',
        '{"action":"abandon","reasoning":"包内无第10期正片"}',
      ]),
      target: {
        ...target,
        title: "地球超新鲜",
        seasons: [1],
        missingEpisodes: ["S01E19"],
        episodeNames: {
          S01E19: "Episode 10 (Part 1)",
          S01E20: "Episode 10 (Part 2)",
        },
      },
      isChineseNative: false,
    });
    // 期号不一致 → 映射被拒 → 诊断仲裁 abandon → 无覆盖、E19 未入库。
    expect(result.coverage.coverageMet).toBe(false);
    expect(result.coverage.obtained ?? []).not.toContain("S01E19");
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

  it("primary 有 A(非唯一)→ 先在 primary 池仲裁转存，不提前跳兜底(PR #25)", async () => {
    let searches = 0;
    const fallbackTarget: TvAnimeTarget = {
      ...target,
      aliases: ["The Knockout"],
    };
    const { sandbox, s1, storage } = await createSetup({
      candidates: [
        { id: "c1", title: "狂飙.S01E01.1080p.中字" },
        { id: "c2", title: "狂飙.S01E02.1080p.中字" }, // 两个 A → 无唯一 top → primary 仲裁
      ],
      extraResults: {
        "the knockout": [{ id: "c3", title: "The Knockout.S01E01.1080p.中字" }],
      },
      packs: { c1: { files: [{ path: "狂飙.S01E01.mkv", sizeBytes: 1_000_000_000 }] } },
      onSearch: () => {
        searches += 1;
      },
    });

    const result = await runFastPathAcquisition({
      sandbox,
      model: textModel('{"candidateId":"c1","reasoning":"c1 正是缺集"}'),
      target: fallbackTarget,
      isChineseNative: false,
    });

    // PR #25:primary 有 A 必须先自己仲裁转存;aliases 兜底只在无 A 或转存失败后才启动。
    expect(result.escalated).toBe(true); // primary 池仲裁
    expect(result.coverage.coverageMet).toBe(true);
    expect(result.coverage.obtained).toEqual(["S01E01"]);
    expect(searches).toBe(1); // 只有 primary 预搜,兜底没触发
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

  it("兜底:primary 有 A(非唯一)→ 先 primary 仲裁转存;兜底只在 primary 试尽后接棒(PR #25)", async () => {
    const { sandbox, s1, storage, aliasTarget, searches } = await createAliasSetup({
      results: {
        狂飙: [
          { id: "c1", title: "狂飙.S01E01.1080p.中字" },
          { id: "c2", title: "狂飙.S01E02.1080p.中字" },
        ], // 两个同题 A → 无唯一 top → primary 池仲裁
        足球教练: [{ id: "c3", title: "狂飙.S01E01.1080p.中字" }], // 兜底唯一 A(不会用到)
      },
      packs: { c1: { files: [{ path: "狂飙.S01E01.mkv", sizeBytes: 1 }] } },
      aliases: ["足球教练"],
    });

    const result = await runFastPathAcquisition({
      sandbox,
      model: textModel('{"candidateId":"c1","reasoning":"c1 是缺集"}'),
      target: aliasTarget,
      isChineseNative: false,
    });

    // PR #25:primary 有 A → 先自己仲裁转存,不提前跳兜底。
    expect(result.escalated).toBe(true);
    expect(result.coverage.coverageMet).toBe(true);
    expect(result.coverage.obtained).toEqual(["S01E01"]);
    expect(searches.length).toBe(1); // 只有 primary,兜底没触发
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

  it("primary 有 A 时兜底不再先于仲裁启动;primary 试尽后才接棒兜底(PR #25)", async () => {
    const { sandbox, s1, storage, aliasTarget, searches } = await createAliasSetup({
      results: {
        狂飙: [
          { id: "c1", title: "狂飙.S01E01.1080p.中字" },
          { id: "c2", title: "狂飙.S01E02.1080p.中字" },
        ], // 两个同题 A → primary 池直接仲裁,兜底无机会启动
        "The Knockout": [], // 兜底结果(命中 0)根本不会被搜
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

    expect(result.escalated).toBe(true); // primary 仲裁
    expect(result.coverage.coverageMet).toBe(true);
    expect((await storage.listTree({ directoryId: s1 })).map((f) => f.path)).toEqual([
      "狂飙.S01E01.mkv",
    ]);
    expect(searches.length).toBe(1); // primary 直接仲裁成功,兜底(甚至搜索)都没启动
  });

  it("§E 合并池:兜底轮的好候选与 primary 一起进仲裁,转存回各自来源快照(母狮案)", async () => {
    const { sandbox, s1, storage, aliasTarget, searches } = await createAliasSetup({
      results: {
        狂飙: [{ id: "c1", title: "狂飙 高清" }], // B(无中字无集数证据)→ 进兜底
        "The Knockout": [{ id: "f1", title: "狂飙 1-3季 高清.中字" }], // 兜底轮的更好 B
      },
      packs: { c1: { files: [] }, f1: { files: [{ path: "狂飙.S01E01.mkv", sizeBytes: 1 }] } },
      aliases: ["The Knockout"],
    });

    const result = await runFastPathAcquisition({
      sandbox,
      model: textModel('{"candidateId":"f1","reasoning":"1-3季 合集带中字,更完整"}'),
      target: aliasTarget,
      isChineseNative: false,
    });

    // 旧行为:恢复只回 primary 池,f1 根本不在仲裁桌上(选中也会触发假 id 防御)。
    // 新行为:合并池 f1 在场,且转存经 candidateSnapshots 回到兜底轮的快照。
    expect(result.escalated).toBe(true);
    expect(result.coverage.coverageMet).toBe(true);
    expect((await storage.listTree({ directoryId: s1 })).map((f) => f.path)).toEqual([
      "狂飙.S01E01.mkv",
    ]);
    expect(searches.length).toBe(2); // 合并纯内存:primary 1 + 兜底 1,零额外搜索
  });

  it("简繁折叠进全链:简体标题命中繁体候选 → 唯一 A 盲转(零仲裁)", async () => {
    const { sandbox, s1, storage, aliasTarget, searches } = await createAliasSetup({
      results: {
        狂飙: [{ id: "c1", title: "狂飆.S01E01.1080p.中字" }], // 繁体候选,折叠后=简体标题
      },
      packs: { c1: { files: [{ path: "狂飙.S01E01.mkv", sizeBytes: 1 }] } },
      aliases: [],
    });

    const result = await runFastPathAcquisition({
      sandbox,
      model: textModel('{"candidateId":"never","reasoning":"不应被调用"}'),
      target: aliasTarget,
      isChineseNative: false,
    });

    expect(result.escalated).toBe(false); // 折叠后是 A 级唯一 → 盲转,不劳 AI
    expect(result.coverage.coverageMet).toBe(true);
    expect((await storage.listTree({ directoryId: s1 })).map((f) => f.path)).toEqual([
      "狂飙.S01E01.mkv",
    ]);
    expect(searches.length).toBe(1); // 折叠不引入额外搜索
  });

  it("PR #25 预算分开:primary 烧满 3/3 转存预算后,兜底池仍用自己的 3 次配额转存成功", async () => {
    // primary 三个 A(c1/c2/c3)全部落 off-target(季号错)→ 诊断 reject_other 逐个换,
    // primary 转存预算 **真烧满 3/3**(旧共享预算:烧完就没配额了,兜底无法再转) →
    // 兜底池启动,兜底搜到唯一 A(c4) → 用兜底**独立**的 3 次配额盲转成功。
    // 核心不变量:primary 试穷不挤占兜底配额(总上限 6)。
    let checkout: string | null = null;
  let checkoutArgs: Record<string, unknown> = {};
    const { sandbox, s1, storage, aliasTarget, searches } = await createAliasSetup({
      results: {
        狂飙: [
          { id: "c1", title: "狂飙.S01E01.1080p.中字" },
          { id: "c2", title: "狂飙.S01E02.1080p.中字" },
          { id: "c3", title: "狂飙.S01E03.1080p.中字" }, // 三个 A → primary 仲裁
        ],
        足球教练: [{ id: "c4", title: "狂飙.S01E01.1080p.中字" }], // 兜底唯一 A
      },
      packs: {
        // c1/c2/c3 都落成 off-target(季号错误)→ 诊断 reject_other → 换下一候选
        c1: { files: [{ path: "狂飙.S02E01.mkv", sizeBytes: 1 }] },
        c2: { files: [{ path: "狂飙.S02E01.mkv", sizeBytes: 1 }] },
        c3: { files: [{ path: "狂飙.S02E01.mkv", sizeBytes: 1 }] },
        c4: { files: [{ path: "狂飙.S01E01.mkv", sizeBytes: 1 }] },
      },
      aliases: ["足球教练"],
    });

    const result = await runFastPathAcquisition({
      sandbox,
      model: sequentialModel([
        '{"candidateId":"c1","reasoning":"选 c1"}', // 选片仲裁(primary 三 A)
        '{"action":"retry_other","reasoning":"季号错"}', // c1 → c2
        '{"action":"retry_other","reasoning":"季号错"}', // c2 → c3
        '{"action":"retry_other","reasoning":"季号错"}', // c3 → 试尽 → 兜底
      ]),
      target: aliasTarget,
      isChineseNative: false,
      onProgress: (event) => {
        if (event.toolName === "runCheckout") { checkout = event.activity; checkoutArgs = event.args as Record<string, unknown>; }
      },
    });

    expect(result.coverage.coverageMet).toBe(true);
    expect(result.coverage.obtained).toEqual(["S01E01"]);
    // 兜底池独立预算:primary 3/3 全废后兜底仍转成 c4。
    expect((await storage.listTree({ directoryId: s1 })).map((f) => f.path)).toEqual([
      "狂飙.S01E01.mkv",
    ]);
    expect(searches.length).toBe(2); // primary 预搜 1 + 兜底重搜 1
    // issue #29 用户拍板:结账行人话(activity 只讲总次数),两池记账进 args 精确校验:
    // primary 3 次全废 + 兜底 1 次成功 = transfers 4, fallbackTransfers=1(primary 的 3 已计)。
    expect(checkout).toContain("转存 4 次完成(含兜底)");
    expect(checkoutArgs.transfers).toBe(4);
    expect(checkoutArgs.fallbackTransfers).toBe(1);
  });

  it("PR #25 死链探测跨两阶段共享:primary 死链 + 兜底死链累计 10 次上限后诚实终止(P1-1)", async () => {
    // 旧 bug:TV 阶段2 从 stale ctx(deadRetries=0)起算 → 死链总探测可达 20(+自身 10 再 +阶段1 10)。
    // 修复后:阶段2 继承阶段1 的 deadRetries,全 run 累计 10 次上限。
    // 场景:primary 先探 3 次死链(3 个 A 候选,未到 10)→ 预算未耗(死链不占)但池耗尽 → 兜底;
    //       兜底 8 个死链候选 → 从 3 起算,第 7 个兜底候选时累计 10 → 终止,不探第 8 个。
    // 若旧 bug(阶段2 从 0 起算),兜底会探满自己的 10 次 → 总 13 次 > 10 红线。
    let deadProbes = 0;
    const { sandbox, aliasTarget, searches } = await createAliasSetup({
      results: {
        狂飙: [
          { id: "c1", title: "狂飙.S01E01.1080p.中字" },
          { id: "c2", title: "狂飙.S01E02.1080p.中字" },
          { id: "c3", title: "狂飙.S01E03.1080p.中字" }, // 3 个 A → primary 仲裁选 c1
        ],
        足球教练: [
          { id: "f1", title: "狂飙.S01E01.1080p.中字" },
          { id: "f2", title: "狂飙.S01E02.1080p.中字" },
          { id: "f3", title: "狂飙.S01E03.1080p.中字" },
          { id: "f4", title: "狂飙.S01E04.1080p.中字" },
          { id: "f5", title: "狂飙.S01E05.1080p.中字" },
          { id: "f6", title: "狂飙.S01E06.1080p.中字" },
          { id: "f7", title: "狂飙.S01E07.1080p.中字" },
          { id: "f8", title: "狂飙.S01E08.1080p.中字" }, // 兜底 8 个(全死链 → 累计 10 上限)
        ],
      },
      packs: {}, // 无任何包 → 全部死链
      aliases: ["足球教练"],
    });

    const result = await runFastPathAcquisition({
      sandbox,
      model: textModel('{"candidateId":"c1","reasoning":"选 c1"}'),
      target: aliasTarget,
      isChineseNative: false,
      onProgress: (event) => {
        if (event.toolName === "transferCandidate" && event.activity?.includes("死链")) {
          deadProbes += 1;
        }
      },
    });

    // 全 run 死链探测累计 10 次上限(primary 3 + 兜底 7),诚实无覆盖。
    expect(deadProbes).toBe(10);
    expect(result.coverage.coverageMet).toBe(false);
    expect(result.text).toContain("未覆盖");
  });
});

describe("runFastPathAcquisition — 步骤写入 agent_steps（Task D）", () => {
  it("成功转存路径:每步写一条 AgentStep(落点检查→预搜→评分→选片→转存→digest→归位→结论)", async () => {
    const repo = new InMemoryWorkflowRepository();
    const trace = makeAgentTraceSink({ repository: repo, workflowRunId: "run-fp-d1" });
    const { sandbox, s1, storage } = await createSetup({
      candidates: [{ id: "c1", title: "狂飙.S01E01.1080p.中字", url: "https://115.com/s/abc123" }],
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
      "gradingDecision",
      "gradeCandidates",
      "pickCandidate",
      "transferCandidate",
      "stagingDigest",
      "digestFiles",
      "finalizeLanding",
      "finish",
      "runCheckout",
    ]);
    expect(steps.map((s) => s.phase)).toEqual([
      "search",
      "search",
      "search",
      "search",
      "pick",
      "transfer",
      "verify",
      "verify",
      "organize",
      "finalize",
      "finalize",
    ]);
    // 序号连续;activity = stepLog 的 detail;转存带 candidateId 参数
    expect(steps.map((s) => s.ordinal)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(steps[1]!.activity).toBe("候选 1 条");
    expect(steps[5]!.args.candidateId).toBe("c1");
    // issue #29:转存步骤带标题 + 链接(用户拍板;链接来自 urlById 透出)。
    expect(steps[5]!.args.title).toBe("狂飙.S01E01.1080p.中字");
    expect(steps[5]!.args.linkUrl).toBe("https://115.com/s/abc123");
    // issue #29 用户拍板:finish 人话化(「已完成:…已入库」);runCheckout 结账行也人话化,
    // activity 只讲结果,统计细节进 args(transfers/searches/aiEscalated)。
    expect(steps[9]!.activity).toContain("已完成:");
    expect(steps[9]!.activity).toContain("已入库");
    expect(steps[10]!.activity).toContain("转存 1 次完成");
    expect(steps[10]!.args.transfers).toBe(1);
    expect(steps[10]!.args.searches).toBe(1);
    // issue #29 用户拍板:digest 人话化——activity 不再报「未通过(脏包)…判定」,
    // 而是一句人话(如「认出 S01E01,还有…」);逐文件识别在 digestFiles 展示一次。
    expect(steps[6]!.activity).not.toContain("脏包");
    expect(steps[6]!.activity).not.toContain("判定");
    expect(steps[7]!.activity).toContain("逐文件识别 1 条");
    // 可观测性增强(L1/L2/L4):决策与证据 payload 随事件走 agent_steps
    // issue #29:gradingDecision 只报决策摘要;候选评级列表只在 gradeCandidates 一次。
    expect(steps[2]!.args.uniqueTopGrade).toBe(true);
    expect(steps[2]!.args.candidates).toBeUndefined();
    expect(steps[3]!.args.uniqueTopGrade).toBe(true);
    expect((steps[3]!.args.candidates as unknown[]).length).toBe(1);
    expect(((steps[3]!.args.candidates as { url?: string }[])[0]?.url)).toBe("https://115.com/s/abc123");
    // issue #29:候选带链接透出(fake provider 此候选无 url,故不强制断言 url)。
    expect((steps[7]!.args.files as string[])[0]).toContain("S01E01");
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
      "gradingDecision",
      "reportNoCoverage",
    ]);
    expect(steps[3]!.activity).toBe("暂无资源(快照为空)");
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
