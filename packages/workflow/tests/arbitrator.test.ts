import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import {
  arbitrateDiagnosis,
  arbitrateMovieDiagnosis,
  arbitrateMovieSelection,
  arbitrateSelection,
  extractJson,
} from "../src/acquisition-v2/arbitrator.js";

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

describe("extractJson", () => {
  it("parses bare JSON", () => {
    expect(extractJson('{"candidateId":"c1","reasoning":"x"}')).toEqual({
      candidateId: "c1",
      reasoning: "x",
    });
  });

  it("tolerates a markdown code fence and surrounding prose", () => {
    const text = '好的。\n```json\n{"action":"accept","reasoning":"ok"}\n```\n以上。';
    expect(extractJson(text)).toEqual({ action: "accept", reasoning: "ok" });
  });

  it("throws on non-JSON output", () => {
    expect(() => extractJson("没有 JSON")).toThrow(/NO_JSON/);
  });
});

describe("arbitrateSelection", () => {
  it("returns the chosen candidate id", async () => {
    const result = await arbitrateSelection({
      model: textModel('{"candidateId":"c-42","reasoning":"唯一像全集"}'),
      summary: "[A] 狂飙.S01E01.1080p.中字",
      title: "狂飙",
      seasons: [1],
    });
    expect(result.candidateId).toBe("c-42");
  });

  it("returns null when the model declines", async () => {
    const result = await arbitrateSelection({
      model: textModel('{"candidateId":null,"reasoning":"全是同名异作"}'),
      summary: "[C] 狂飙 电影版",
      title: "狂飙",
      seasons: [1],
    });
    expect(result.candidateId).toBeNull();
  });

  it("degrades to a safe decline on unparseable output", async () => {
    const result = await arbitrateSelection({
      model: textModel("抱歉，我不知道"),
      summary: "[B] 狂飙",
      title: "狂飙",
      seasons: [1],
    });
    expect(result.candidateId).toBeNull();
  });
});

describe("arbitrateDiagnosis", () => {
  it("returns the action", async () => {
    const result = await arbitrateDiagnosis({
      model: textModel('{"action":"retry_other","reasoning":"季号错了"}'),
      summary: "季外集数: S02E01",
      title: "狂飙",
    });
    expect(result.action).toBe("retry_other");
  });

  it("validates the action against the three allowed values", async () => {
    const result = await arbitrateDiagnosis({
      model: textModel('{"action":"explode","reasoning":"bad"}'),
      summary: "whatever",
      title: "狂飙",
    });
    // Invalid action → safe fallback to abandon.
    expect(result.action).toBe("abandon");
  });

  it("degrades to abandon on unparseable output", async () => {
    const result = await arbitrateDiagnosis({
      model: textModel("not json"),
      summary: "whatever",
      title: "狂飙",
    });
    expect(result.action).toBe("abandon");
  });
});

describe("arbitrateMovieSelection", () => {
  it("returns the chosen candidate id (film identity = title + year)", async () => {
    const result = await arbitrateMovieSelection({
      model: textModel('{"candidateId":"c-9","reasoning":"片名年份都一致"}'),
      summary: "[B] 流浪地球 4K",
      title: "流浪地球",
      year: 2019,
    });
    expect(result.candidateId).toBe("c-9");
  });

  it("returns null when the model declines", async () => {
    const result = await arbitrateMovieSelection({
      model: textModel('{"candidateId":null,"reasoning":"都是同名异作"}'),
      summary: "[C] 流浪地球 2023",
      title: "流浪地球",
      year: 2019,
    });
    expect(result.candidateId).toBeNull();
  });

  it("degrades to a safe decline on unparseable output", async () => {
    const result = await arbitrateMovieSelection({
      model: textModel("不知道"),
      summary: "[B] 流浪地球 4K",
      title: "流浪地球",
      year: 2019,
    });
    expect(result.candidateId).toBeNull();
  });
});

describe("arbitrateMovieDiagnosis", () => {
  it("returns the action", async () => {
    const result = await arbitrateMovieDiagnosis({
      model: textModel('{"action":"retry_other","reasoning":"年份对不上，是 remake"}'),
      summary: "视频: 流浪地球.2023.mkv",
      title: "流浪地球",
      year: 2019,
    });
    expect(result.action).toBe("retry_other");
  });

  it("validates the action against the three allowed values", async () => {
    const result = await arbitrateMovieDiagnosis({
      model: textModel('{"action":"explode","reasoning":"bad"}'),
      summary: "whatever",
      title: "流浪地球",
      year: 2019,
    });
    expect(result.action).toBe("abandon");
  });

  it("degrades to abandon on unparseable output", async () => {
    const result = await arbitrateMovieDiagnosis({
      model: textModel("not json"),
      summary: "whatever",
      title: "流浪地球",
      year: 2019,
    });
    expect(result.action).toBe("abandon");
  });
});
