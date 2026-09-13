import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { runAcquisitionV2, subtitleGateSatisfied } from "../src/acquisition-v2/orchestrator.js";
import type { ResourceProvider } from "../src/ports.js";
import type { ResourceSnapshot } from "../src/domain.js";
import type { AssrtCandidate, AssrtSubtitleFile } from "../src/subtitle-provider.js";
import { FakeStorageExecutor } from "../src/fakes.js";

const USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
} as const;

/** A model that stops immediately — the subtitle PRE-WARM side effect we assert
 *  happens BEFORE the loop runs, so the agent behavior itself doesn't matter. */
function stopModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text" as const, text: "done" }],
      finishReason: { unified: "stop" as const, raw: "stop" as const },
      usage: USAGE,
      warnings: [],
    }),
  });
}

function emptyProvider(): ResourceProvider {
  return {
    search: async ({ keyword }): Promise<ResourceSnapshot> => ({
      id: "snap_empty",
      provider: "pansou",
      keyword,
      candidates: [],
      createdAt: "2026-07-01T00:00:00.000Z",
    }),
  };
}

/** An assrt provider that records how many times search() was called, so we can
 *  assert the pre-warm gate: 1 call when all gates pass, 0 when any gate fails. */
function spyingAssrtProvider(): {
  provider: { search(k: string): Promise<AssrtCandidate[]>; detail(id: number): Promise<AssrtSubtitleFile[]> };
  state: { searchCalls: number };
} {
  const state = { searchCalls: 0 };
  const provider = {
    search: async (_k: string): Promise<AssrtCandidate[]> => {
      state.searchCalls += 1;
      return [];
    },
    detail: async (_id: number): Promise<AssrtSubtitleFile[]> => [],
  };
  return { provider, state };
}

/** Run a movie acquisition with the given gate inputs; return how many times
 *  assrt.search was called (the pre-warm indicator). */
/** A FakeStorageExecutor that CAN land subtitle urls — the capability the
 *  orchestrator gate probes for. Brand string is irrelevant; the optional
 *  method's presence is the single source of truth. */
class SubtitleCapableExecutor extends FakeStorageExecutor {
  async transferSubtitleUrl(input: {
    url: string;
    filename: string;
    directoryId: string;
    workflowRunId: string;
  }) {
    return {
      id: `${input.workflowRunId}_subtitle_1`,
      workflowRunId: input.workflowRunId,
      candidateId: `subtitle:${input.filename}`,
      status: "succeeded" as const,
      providerMessage: "",
      materializedFileIds: [],
    };
  }
}

async function runWithGates(gates: {
  originCountries: string[];
  storageProvider: string;
  assrtToken?: string;
  /** true → executor implements transferSubtitleUrl (e.g. 115); false → it
   *  doesn't (e.g. quark today). */
  subtitleCapable: boolean;
}): Promise<number> {
  const { provider: assrtProvider, state } = spyingAssrtProvider();
  const executorOptions = { directories: { staging: [], movie: [] } };
  await runAcquisitionV2({
    provider: emptyProvider(),
    executor: gates.subtitleCapable
      ? new SubtitleCapableExecutor(executorOptions)
      : new FakeStorageExecutor(executorOptions),
    model: stopModel(),
    workflowRunId: "run-test",
    target: { kind: "movie", title: "Inception", aliases: [], year: 2010, qualityPreference: "4K" },
    stagingDirectoryId: "staging",
    targetMovieDirectoryId: "movie",
    originCountries: gates.originCountries,
    storageProvider: gates.storageProvider,
    ...(gates.assrtToken === undefined ? {} : { assrtToken: gates.assrtToken }),
    assrtProvider,
  });
  return state.searchCalls;
}

describe("subtitleGateSatisfied — 字幕三重闸门(纯函数,与品牌字符串无关)", () => {
  // ⚠️ 2026-09-13 字幕总开关(SUBTITLES_ENABLED)关闭后,整条字幕链在生产上永不触发,
  // 闸门语义只能在这里覆盖。原来这 7 个用例通过端到端预热次数验证闸门,现在会全部
  // 塌成 0 次调用、失去区分度 —— 故把判据抽成 orchestrator.ts 的纯函数单独测。
  // 恢复支持字幕时(开关改回 true),对着这一组用例验收即可。

  it("闸门全过:token 已配 + 已知非 CN origin + 执行器能落字幕", () => {
    expect(
      subtitleGateSatisfied({ assrtToken: "fake-token", originCountries: ["US"], canLandSubtitleUrls: true }),
    ).toBe(true);
  });

  it("brand 字符串无关:能力探测只看方法存在性 —— 光鸭哪天实现 transferSubtitleUrl 就自动点亮", () => {
    // 判据签名里根本没有品牌参数,这就是「无关」的结构化表达。
    expect(
      subtitleGateSatisfied({ assrtToken: "fake-token", originCountries: ["US"], canLandSubtitleUrls: true }),
    ).toBe(true);
  });

  it("多 origin 全非 CN 也算过", () => {
    expect(
      subtitleGateSatisfied({ assrtToken: "t", originCountries: ["US", "JP"], canLandSubtitleUrls: true }),
    ).toBe(true);
  });

  it("origin 含 CN 即不过", () => {
    expect(subtitleGateSatisfied({ assrtToken: "t", originCountries: ["CN"], canLandSubtitleUrls: true })).toBe(
      false,
    );
  });

  it("多 origin 里含 CN 也不过", () => {
    expect(
      subtitleGateSatisfied({ assrtToken: "t", originCountries: ["CN", "US"], canLandSubtitleUrls: true }),
    ).toBe(false);
  });

  it("token 未配即不过", () => {
    expect(subtitleGateSatisfied({ originCountries: ["US"], canLandSubtitleUrls: true })).toBe(false);
  });

  it("token 是空串/纯空白也算未配", () => {
    expect(subtitleGateSatisfied({ assrtToken: "", originCountries: ["US"], canLandSubtitleUrls: true })).toBe(false);
    expect(subtitleGateSatisfied({ assrtToken: "   ", originCountries: ["US"], canLandSubtitleUrls: true })).toBe(
      false,
    );
  });

  it("执行器没有 transferSubtitleUrl 即不过(夸克今天如此)—— 闸门永不与执行器实际能力不一致", () => {
    expect(
      subtitleGateSatisfied({ assrtToken: "t", originCountries: ["US"], canLandSubtitleUrls: false }),
    ).toBe(false);
  });

  it("origin 元数据缺失/为空按**不合格** —— 防 niche 国产短剧每次巡检空烧 assrt 配额(20/min)", () => {
    expect(subtitleGateSatisfied({ assrtToken: "t", originCountries: [], canLandSubtitleUrls: true })).toBe(false);
    expect(subtitleGateSatisfied({ assrtToken: "t", canLandSubtitleUrls: true })).toBe(false);
  });
});

describe("字幕总开关(SUBTITLES_ENABLED=false)—— 生产上整条字幕链休眠", () => {
  // 端到端只断言一件生产可观测的事:assrt 完全不被调用。
  // 闸门内部判据由上一组纯函数用例覆盖 —— 开关关闭时端到端会全部塌成 0,没有区分度。
  it("即使三重闸门全过也不预热(2026-09-13 用户拍板暂不支持字幕)", async () => {
    expect(
      await runWithGates({
        originCountries: ["US"],
        storageProvider: "pan115",
        assrtToken: "fake-token",
        subtitleCapable: true,
      }),
    ).toBe(0);
  });
});
