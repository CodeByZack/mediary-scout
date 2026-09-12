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
  tmdbPeriodInName,
} from "../src/index.js";
import { syncSeasonAgainstMetadata } from "../src/season-sync.js";
import type { TvAnimeTarget } from "../src/acquisition-v2/target-types.js";

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
    expect(seasonNumbersInTitle("【综艺】花儿与少年4.完结")).toEqual([4]);
    expect(seasonNumbersInTitle("X 2019.合集")).toEqual([]);
    // 日期残段:2026.09.完结 的 09 前是点号,不是季号
    expect(seasonNumbersInTitle("X 2026.09.完结")).toEqual([]);
    expect(seasonNumbersInTitle("X 2026.09.全集")).toEqual([]);
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

  it("`4.完结` 包:S08 任务 = C(2026-09-12 花儿与少年假入库 —— 完结此前不在季号正则里)", () => {
    const gradeFor = (seasons: number[]) =>
      gradeCandidates([{ id: "c1", title: "【综艺】花儿与少年4.完结" }], {
        title: "花儿与少年",
        aliases: [],
        seasons,
        isChineseNative: true,
      }).ranked[0]!.grade;
    expect(gradeFor([8])).toBe("C");
    expect(gradeFor([4])).toBe("A");
  });
});

/**
 * 综艺「第N期」Part 锚定 —— 集名形态全部取自 2026-09-12 线上 TMDB 实测
 * (https://tmdb-proxy.mediaryscout.app/tv/{id}/season/{n}),非合成假设:
 *   地球超新鲜 S1(id 296202): `Episode 1 (Part 1)`  ← 代码原案子
 *   花儿与少年 S8  (id 121876): `EP1-1` / `EP1-2` / `EP1-3`  ← 一期三部分
 *   花儿与少年 S7  (id 121876): `EP1` / `EP2-1` / `EP2-2`  ← 不分与拆分混用
 *   中餐厅 S10    (id 91914) : `Episode 1`             ← 无部分
 */
describe("anchorVarietyPeriod — 一期拆多部分的四种 TMDB 集名形态", () => {
  const wowS1: Record<string, string> = {
    S01E01: "Episode 1 (Part 1)",
    S01E02: "Episode 1 (Part 2)",
    S01E03: "Episode 2 (Part 1)",
    S01E04: "Episode 2 (Part 2)",
  };
  const divasS8: Record<string, string> = {
    S08E01: "EP1-1",
    S08E02: "EP1-2",
    S08E03: "EP1-3",
    S08E04: "Episode 4",
  };
  const divasS7: Record<string, string> = {
    S07E01: "EP1",
    S07E02: "EP2-1",
    S07E03: "EP2-2",
    S07E04: "EP3",
  };
  const chefS10: Record<string, string> = { S10E01: "Episode 1", S10E02: "Episode 2" };

  it("地球超新鲜 `Episode N (Part K)`:第N期上/下 对上/下两部分", () => {
    expect(episodeCodeFromFileName("2025.07.27-第1期上.mp4", [1], wowS1)).toBe("S01E01");
    expect(episodeCodeFromFileName("2025.07.28-第1期下.mp4", [1], wowS1)).toBe("S01E02");
    expect(episodeCodeFromFileName("2025.08.04-第2期下.mp4", [1], wowS1)).toBe("S01E04");
    // 空格容忍
    expect(episodeCodeFromFileName("第1期 下.mp4", [1], wowS1)).toBe("S01E02");
  });

  it("花儿与少年 S8 `EP1-1/EP1-2/EP1-3`:第1期上/中/下 对三部分", () => {
    expect(episodeCodeFromFileName("2026.09.10-第1期上.mp4", [8], divasS8)).toBe("S08E01");
    expect(episodeCodeFromFileName("2026.09.10-第1期中.mp4", [8], divasS8)).toBe("S08E02");
    expect(episodeCodeFromFileName("2026.09.11-第1期下.mp4", [8], divasS8)).toBe("S08E03");
    // 第4期无部分标记 → 该期唯一集
    expect(episodeCodeFromFileName("2026.09.17-第4期.mp4", [8], divasS8)).toBe("S08E04");
  });

  it("花儿与少年 S7 不分与拆分混用:不分期取唯一集,拆分期按标记分配", () => {
    expect(episodeCodeFromFileName("2025.08.16-第1期.mp4", [7], divasS7)).toBe("S07E01");
    expect(episodeCodeFromFileName("2025.08.23-第2期上.mp4", [7], divasS7)).toBe("S07E02");
    expect(episodeCodeFromFileName("2025.08.23-第2期下.mp4", [7], divasS7)).toBe("S07E03");
    // 标记多于实际部分数 → 回落到最后一部分,不返回 null
    expect(episodeCodeFromFileName("2025.08.23-第2期中.mp4", [7], divasS7)).toBe("S07E03");
  });

  it("中餐厅 `Episode N`(无部分):第N期 → 对应集,机械 E(N) 与锚定一致", () => {
    expect(episodeCodeFromFileName("2026.06.19-第1期.mp4", [10], chefS10)).toBe("S10E01");
    expect(episodeCodeFromFileName("2026.06.26-第2期.mp4", [10], chefS10)).toBe("S10E02");
  });

  it("tmdbPeriodInName — Part 锚定与 landing 期号校验共用同一抽取器", () => {
    // 旧 landing 校验用 /Episode\s*(\d+)/ 私有正则,连字符形态全 null → 校验整季惰性。
    expect(tmdbPeriodInName("Episode 1 (Part 1)")).toBe("1");
    expect(tmdbPeriodInName("EP1")).toBe("1");
    expect(tmdbPeriodInName("EP1-1")).toBe("1");
    expect(tmdbPeriodInName("EP2-2")).toBe("2");
    expect(tmdbPeriodInName("Episode 4")).toBe("4");
    expect(tmdbPeriodInName("EP 1080p")).toBeNull();
    expect(tmdbPeriodInName("世界树奇遇派对")).toBeNull();
    expect(tmdbPeriodInName("S08E01")).toBeNull();
  });

  it("同一期同时有 `EP3` 与 `EP3-1/EP3-2`:带标记时取部分号,不吞无标记条目", () => {
    const mixed: Record<string, string> = {
      S03E01: "EP3",
      S03E02: "EP3-1",
      S03E03: "EP3-2",
    };
    // 无标记 → 仍取无标记条目(该期正片主体)
    expect(episodeCodeFromFileName("第3期.mp4", [3], mixed)).toBe("S03E01");
    // 有标记 → 只在带部分号的集里对号入座(旧实现 find(part === 1) 的语义)
    expect(episodeCodeFromFileName("第3期上.mp4", [3], mixed)).toBe("S03E02");
    expect(episodeCodeFromFileName("第3期下.mp4", [3], mixed)).toBe("S03E03");
  });

  it("无 episodeNames / 该期不在表内 / 集名无期号 → 回退机械 E(N)", () => {
    expect(episodeCodeFromFileName("2026.09.10-第1期上.mp4", [8])).toBe("S08E01");
    expect(episodeCodeFromFileName("第99期上.mp4", [8], divasS8)).toBe("S08E99");
    expect(
      episodeCodeFromFileName("2026.09.10-第1期上.mp4", [8], { S08E01: "世界树奇遇派对" }),
    ).toBe("S08E01");
  });

  it("衍生内容黑名单优先级不变:带「第N期」的衍生片段即使能锚定也不给集号", () => {
    expect(episodeCodeFromFileName("2025.07.27-独家直拍第1期上.mp4", [1], wowS1)).toBeNull();
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

  it("集名落库(issue #27):占位标题被真名盖掉,计数不变也生效,已获取标记不动", () => {
    const season = {
      id: "t_s8", mediaTitleId: "t", seasonNumber: 8, status: "active" as const,
      qualityPreference: "1080p", storageDirectoryId: "", totalEpisodes: 3, latestAiredEpisode: 3,
      latestAiredSource: "metadata" as const,
    };
    // DB 现状:标题全是占位符(Part 锚定数据从未落库)
    const episodes = createEpisodeStates({
      trackedSeasonId: "t_s8", seasonNumber: 8, totalEpisodes: 3, latestAiredEpisode: 3,
    });
    expect(episodes[0]!.title).toBe("Episode 1");
    episodes[0] = { ...episodes[0]!, obtained: true, verifiedFileIds: ["f1"] };
    const out = syncSeasonAgainstMetadata({
      season, episodes, latestAiredEpisode: 3, totalEpisodes: 3,
      episodeNames: { S08E01: "EP1-1", S08E02: "EP1-2", S08E03: "EP1-3" },
    });
    expect(out.changed).toBe(true);
    expect(out.episodes.map((episode) => episode.title)).toEqual(["EP1-1", "EP1-2", "EP1-3"]);
    // obtained 集照样换真名,但 obtained / 已验证文件不动
    expect(out.episodes[0]!.obtained).toBe(true);
    expect(out.episodes[0]!.verifiedFileIds).toEqual(["f1"]);
  });

  it("集名幂等:真名已在库里时不重复报 changed;TMDB 回落占位符不倒退旧真名", () => {
    const season = {
      id: "t_s8", mediaTitleId: "t", seasonNumber: 8, status: "active" as const,
      qualityPreference: "1080p", storageDirectoryId: "", totalEpisodes: 2, latestAiredEpisode: 2,
      latestAiredSource: "metadata" as const,
    };
    const episodes = createEpisodeStates({
      trackedSeasonId: "t_s8", seasonNumber: 8, totalEpisodes: 2, latestAiredEpisode: 2,
      episodeNames: { S08E01: "EP1-1", S08E02: "EP1-2" },
    });
    expect(syncSeasonAgainstMetadata({
      season, episodes, latestAiredEpisode: 2, totalEpisodes: 2,
      episodeNames: { S08E01: "EP1-1", S08E02: "EP1-2" },
    }).changed).toBe(false);

    // TMDB 偶发缺 name → createEpisodeStates 回落 "Episode N",不应盖掉库里真名
    const regressed = syncSeasonAgainstMetadata({
      season, episodes, latestAiredEpisode: 2, totalEpisodes: 2,
      episodeNames: { S08E01: "EP1-1", S08E02: "Episode 2" },
    });
    expect(regressed.episodes[1]!.title).toBe("EP1-2");
  });
});
