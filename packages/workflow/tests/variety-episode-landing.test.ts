import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { TaskSandbox } from "../src/acquisition-v2/sandbox.js";
import { FakeResourceProviderV2 } from "../src/acquisition-v2/fake-provider.js";
import { Storage115Simulator, type SimTreeFile } from "../src/acquisition-v2/storage-115-simulator.js";
import { runFastPathAcquisition } from "../src/consumption/fast-path/tv.js";
import { digestStaging } from "../src/acquisition-v2/staging-digest.js";
import {
  gradeCandidates,
  seasonNumbersInTitle,
  seasonRangeInTitle,
} from "../src/acquisition-v2/candidate-grader.js";
import {
  cleanTitleForCanonicalName,
  createEpisodeStates,
  episodeCodeFromFileName,
  episodeDateConflict,
  explicitFileDate,
} from "../src/index.js";
import { syncSeasonAgainstMetadata } from "../src/season-sync.js";
import type { TvAnimeTarget } from "../src/acquisition-v2/task-agents.js";

/**
 * 2026-08-30 中餐厅 S10E11 巡检事故的四合一验收:
 *   ① 解析器识别「第N期」(综艺正片),衍生变体(加更/直拍/手记…)带号也拒收;
 *   ② issue #21 隐形季号(`3.全集`/裸`N季`/`1-10季` 范围)进 mismatch 闸门;
 *   ③ finalize 只补缺集(onlyCodes) —— 非缺集的解析成果不再顺带入库;
 *   ④ 年守卫 —— 文件自带日期与该集 TMDB 播出日矛盾(>45 天)不采信。
 */

function video(name: string, id = name): SimTreeFile {
  return { id, path: name, sizeBytes: 1_000_000_000, isVideo: true, isSubtitle: false };
}

const USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
} as const;

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

function throwModel() {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      throw new Error("MODEL_SHOULD_NOT_BE_CALLED");
    },
  });
}

describe("episodeCodeFromFileName — 综艺「第N期」(解析契约①)", () => {
  it("单季任务里解析正片 第N期 → 目标季集码", () => {
    expect(episodeCodeFromFileName("2026.08.29.第11期.mp4", [10])).toBe("S10E11");
    expect(episodeCodeFromFileName("20260619.第1期.mp4", [10])).toBe("S10E01");
    expect(episodeCodeFromFileName("20250704(第3期).mp4", [9])).toBe("S09E03");
  });

  it("衍生内容黑名单:带「第N期」也不给集号", () => {
    expect(episodeCodeFromFileName("2026.08.09-独家直拍第8期.mp4", [10])).toBeNull();
    expect(episodeCodeFromFileName("2025.07.02-合伙人手记第4期.mp4", [10])).toBeNull();
    expect(episodeCodeFromFileName("2025.08.30-加更班第11期.mp4", [10])).toBeNull();
    expect(episodeCodeFromFileName("2025.07.26-加更版第6期.mp4", [10])).toBeNull();
    expect(episodeCodeFromFileName("20260622.超前Vlog：十周年回忆之书.mp4", [10])).toBeNull();
  });

  it("「第N集/话」原语义不动(黑名单不外溢)", () => {
    expect(episodeCodeFromFileName("Show - 第6话.mkv", [1])).toBe("S01E06");
    expect(episodeCodeFromFileName("末日地堡.第3集.mp4", [3])).toBe("S03E03");
  });

  it("多季任务禁用「第N期」(季不明交仲裁)", () => {
    expect(episodeCodeFromFileName("2026.08.29.第11期.mp4", [9, 10])).toBeNull();
  });

  it("cleanTitleForCanonicalName 一并剥掉 第N期", () => {
    expect(cleanTitleForCanonicalName("中餐厅 第10期")).toBe("中餐厅");
  });
});

describe("explicitFileDate / episodeDateConflict(年守卫④)", () => {
  it("四种日期形态 + 紧凑形态", () => {
    expect(explicitFileDate("2025.08.29-第11期.mp4")).toBe("2025-08-29");
    expect(explicitFileDate("2025-08-29 第11期.mp4")).toBe("2025-08-29");
    expect(explicitFileDate("2025/08/29-第11期.mp4")).toBe("2025-08-29");
    expect(explicitFileDate("20250829第11期.mp4")).toBe("2025-08-29");
    expect(explicitFileDate("2025年8月29日第11期.mp4")).toBe("2025-08-29");
  });

  it("负例:分辨率/半年份/裸年份/坏月日都不是日期", () => {
    expect(explicitFileDate("Show.S01E01.1920x1080.mkv")).toBeNull();
    expect(explicitFileDate("2026.06.第1期.mp4")).toBeNull();
    expect(explicitFileDate("中餐厅 2026.mp4")).toBeNull();
    expect(explicitFileDate("20251332第1期.mp4")).toBeNull();
  });

  it("冲突判定:差 >45 天真,近期/无日期/无播出日数据都假", () => {
    const airDates = { S10E11: "2026-08-28" };
    expect(episodeDateConflict("S10E11", "2025.08.29-第11期.mp4", airDates)).toBe(true);
    expect(episodeDateConflict("S10E11", "2026.08.29.第11期.mp4", airDates)).toBe(false);
    expect(episodeDateConflict("S10E11", "第11期.mp4", airDates)).toBe(false);
    expect(episodeDateConflict("S10E11", "2025.08.29-第11期.mp4", {})).toBe(false);
    expect(episodeDateConflict("S10E11", "2025.08.29-第11期.mp4", undefined)).toBe(false);
  });
});

describe("candidate-grader — 隐形季号(issue #21 验收②)", () => {
  const packTitle = "【美剧】星际迷航：奇异新世界3.全集（星际迷航奇异新世界3）";

  it("seasonNumbersInTitle 看见 `3.全集`/裸`N季`,不认错觉形态", () => {
    expect(seasonNumbersInTitle(packTitle)).toEqual([3]);
    expect(seasonNumbersInTitle("中餐厅3季")).toEqual([3]);
    expect(seasonNumbersInTitle("X 2019.合集")).toEqual([]);
    expect(seasonNumbersInTitle("X 全20集")).toEqual([]);
    expect(seasonNumbersInTitle("X 共3季")).toEqual([]);
    expect(seasonNumbersInTitle("X 1-10季")).toEqual([]);
  });

  it("seasonRangeInTitle 认范围", () => {
    expect(seasonRangeInTitle("国内真人秀《中餐厅》（1-10季）（2017-2026）")).toEqual([1, 10]);
    expect(seasonRangeInTitle("中餐厅 第十季")).toBeNull();
  });

  it("`3.全集` 包:S01/S02 任务 = C,S03 任务 = A", () => {
    const gradeFor = (seasons: number[]) =>
      gradeCandidates([{ id: "c1", title: packTitle }], {
        title: "星际迷航：奇异新世界",
        aliases: [],
        seasons,
      }).ranked[0]!.grade;
    expect(gradeFor([1])).toBe("C");
    expect(gradeFor([2])).toBe("C");
    expect(gradeFor([3])).toBe("A");
  });

  it("范围包:任务季在范围内维持 B(不作 A 证据),范围外降 C", () => {
    const ctx = (seasons: number[]) => ({
      title: "中餐厅",
      aliases: [],
      seasons,
      isChineseNative: true,
    });
    const title = "国内真人秀《中餐厅》（1-10季）（2017-2026）[夸克网盘]";
    expect(gradeCandidates([{ id: "c1", title }], ctx([10])).ranked[0]!.grade).toBe("B");
    expect(gradeCandidates([{ id: "c1", title }], ctx([20])).ranked[0]!.grade).toBe("C");
  });
});

describe("digestStaging — 年守卫 + 综艺包(①④)", () => {
  it("2026 综艺包:正片解析成集数,花絮仍判脏(解析不再全军覆没)", () => {
    const d = digestStaging({
      files: [
        video("20260619.第1期.mp4"),
        video("20260807.第8期.mp4"),
        video("2026.08.09-独家直拍第8期.mp4"),
        video("20260821.加更版.mp4"),
      ],
      seasons: [10],
      needCodes: ["S10E08"],
    });
    expect(d.episodeCodes).toEqual(["S10E01", "S10E08"]);
    expect(d.coveredCodes).toEqual(["S10E08"]);
  });

  it("第九季文件(2025 日期)在 S10 任务 + 播出日数据下全部不采信", () => {
    const d = digestStaging({
      files: [video("2025.08.29-第11期.mp4"), video("2025.06.27-第2期.mp4")],
      seasons: [10],
      needCodes: ["S10E11"],
      episodeAirDates: { S10E11: "2026-08-28", S10E02: "2026-06-27" },
    });
    expect(d.episodeCodes).toEqual([]);
    expect(d.dateRejectedVideos).toHaveLength(2);
    expect(d.coveredCodes).toEqual([]);
    expect(d.missingCodes).toEqual(["S10E11"]);
    expect(d.summary).toContain("季份日期不符剔除");
  });

  it("播出日对得上则正常采信;无播出日数据时守卫惰性(旧语义)", () => {
    const good = digestStaging({
      files: [video("2026.08.29.第11期.mp4")],
      seasons: [10],
      needCodes: ["S10E11"],
      episodeAirDates: { S10E11: "2026-08-28" },
    });
    expect(good.episodeCodes).toEqual(["S10E11"]);
    expect(good.coveredCodes).toEqual(["S10E11"]);
    expect(good.passes).toBe(true);

    const legacy = digestStaging({
      files: [video("2025.08.29-第11期.mp4")],
      seasons: [10],
      needCodes: ["S10E11"],
    });
    expect(legacy.episodeCodes).toEqual(["S10E11"]);
  });
});

const zctTarget: TvAnimeTarget = {
  title: "中餐厅",
  aliases: [],
  seasons: [10],
  missingEpisodes: ["S10E11"],
  qualityPreference: "1080p",
  episodeAirDates: { S10E11: "2026-08-28" },
};

async function createZhongcantingSetup(
  packs: Record<string, { files: Array<{ path: string; sizeBytes: number }> }>,
) {
  const provider = new FakeResourceProviderV2({
    results: { 中餐厅: [{ id: "c1", title: "中餐厅 第十季" }] },
  });
  const storage = new Storage115Simulator({ packs });
  const stagingDirectoryId = await storage.createDirectory({ name: "staging", parentId: "root" });
  const s10 = await storage.createDirectory({ name: "Season 10", parentId: "root" });
  const sandbox = new TaskSandbox({
    provider,
    storage,
    stagingDirectoryId,
    targetSeasonDirectoryIds: { 10: s10 },
    need: ["S10E11"],
    canonicalTitle: "中餐厅",
    titleTerms: ["中餐厅"],
  });
  await sandbox.primeRawSnapshot("中餐厅");
  return { sandbox, storage, s10 };
}

describe("fast-path 回放 — 2026-08-30 中餐厅 S10E11", () => {
  it("唯一 A 盲转纯综艺正片包:零 AI 直接入库(①的正面)", async () => {
    const { sandbox, storage, s10 } = await createZhongcantingSetup({
      c1: { files: [{ path: "2026.08.29.第11期.mp4", sizeBytes: 1_000_000_000 }] },
    });
    const result = await runFastPathAcquisition({
      sandbox,
      model: throwModel(),
      target: zctTarget,
      isChineseNative: true,
    });
    expect(result.escalated).toBe(false);
    expect(result.coverage.obtained).toEqual(["S10E11"]);
    expect((await storage.listTree({ directoryId: s10 })).map((f) => f.path)).toEqual([
      "中餐厅.S10E11.mp4",
    ]);
  });

  it("合集包实为第九季(2025 日期):年守卫拒收 → 诚实无覆盖,零假入库(④)", async () => {
    const { sandbox, storage, s10 } = await createZhongcantingSetup({
      c1: {
        files: [
          { path: "2025.08.29-第11期.mp4", sizeBytes: 1_000_000_000 },
          { path: "2025.06.27-第2期.mp4", sizeBytes: 1_000_000_000 },
          { path: "20250702-合伙人手记.mp4", sizeBytes: 1_000_000 },
        ],
      },
    });
    const result = await runFastPathAcquisition({
      sandbox,
      model: sequentialModel([
        '{"mapping":{},"unmapped":["2025.08.29-第11期.mp4","2025.06.27-第2期.mp4","20250702-合伙人手记.mp4"],"reasoning":"日期与播出年均不符"}',
        '{"action":"abandon","reasoning":"包内是第九季内容"}',
      ]),
      target: zctTarget,
      isChineseNative: true,
    });
    expect(result.escalated).toBe(true);
    expect(result.coverage.coverageMet).toBe(false);
    expect(result.coverage.missing).toEqual(["S10E11"]);
    expect(await storage.listTree({ directoryId: s10 })).toEqual([]);
  });

  it("包混有已获取集与超前集:只补缺的那一集(③)", async () => {
    const { sandbox, storage, s10 } = await createZhongcantingSetup({
      c1: {
        files: [
          { path: "2026.08.29.第11期.mp4", sizeBytes: 1_000_000_000 },
          { path: "2026.06.27.第2期.mp4", sizeBytes: 1_000_000_000 },
          { path: "2026.09.05.第12期.mp4", sizeBytes: 1_000_000_000 },
          { path: "2026.08.16.独家直拍第9期.mp4", sizeBytes: 1_000_000 },
          { path: "20260821.加更版.mp4", sizeBytes: 1_000_000 },
        ],
      },
    });
    const result = await runFastPathAcquisition({
      sandbox,
      // need(S10E11)已被代码解析覆盖 → 不再触发 AI 集数映射(2026-08-31 起仅在
      // 代码解析未覆盖缺集时调用),脏包直接走诊断仲裁 accept。
      model: sequentialModel(['{"action":"accept","reasoning":"目标集已在包内,花絮忽略"}']),
      target: zctTarget,
      isChineseNative: true,
    });
    expect(result.coverage.coverageMet).toBe(true);
    expect(result.coverage.obtained).toEqual(["S10E11"]);
    expect((await storage.listTree({ directoryId: s10 })).map((f) => f.path)).toEqual([
      "中餐厅.S10E11.mp4",
    ]);
  });
});

describe("syncSeasonAgainstMetadata — 播出日回填(年守卫④数据源)", () => {
  it("计数不变也把 airDate 补进 episode_states,changed=true,已获取标记不动", () => {
    const season = {
      id: "t_s1", mediaTitleId: "t", seasonNumber: 1, status: "active" as const,
      qualityPreference: "1080p", storageDirectoryId: "", totalEpisodes: 2, latestAiredEpisode: 2,
      latestAiredSource: "metadata" as const,
    };
    const episodes = createEpisodeStates({
      trackedSeasonId: "t_s1", seasonNumber: 1, totalEpisodes: 2, latestAiredEpisode: 2,
    });
    expect(episodes[0]!.airDate).toBeNull();
    episodes[0] = { ...episodes[0]!, obtained: true };
    const out = syncSeasonAgainstMetadata({
      season, episodes, latestAiredEpisode: 2, totalEpisodes: 2,
      episodeAirDates: { S01E01: "2026-08-21", S01E02: "2026-08-28" },
    });
    expect(out.changed).toBe(true);
    expect(out.episodes[0]!.airDate).toBe("2026-08-21");
    expect(out.episodes[0]!.obtained).toBe(true);
    expect(out.episodes[1]!.airDate).toBe("2026-08-28");
    // 已有 airDate 不被覆盖
    const again = syncSeasonAgainstMetadata({
      season, episodes: out.episodes, latestAiredEpisode: 2, totalEpisodes: 2,
      episodeAirDates: { S01E01: "2026-09-01" },
    });
    expect(again.changed).toBe(false);
    expect(again.episodes[0]!.airDate).toBe("2026-08-21");
  });
});
