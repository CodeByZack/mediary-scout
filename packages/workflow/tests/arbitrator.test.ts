import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import {
  arbitrateDiagnosis,
  arbitrateEpisodeMapping,
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
      summary: "[A] [c-42] 狂飙.S01E01.1080p.中字",
      title: "狂飙",
      seasons: [1],
    });
    expect(result.candidateId).toBe("c-42");
  });

  it("tells the model to copy candidateId from the [id] bracket (and the summary carries it)", async () => {
    const model = textModel('{"candidateId":"c-42","reasoning":"唯一像全集"}');
    const result = await arbitrateSelection({
      model,
      summary: "[A] [c-42] 狂飙.S01E01.1080p.中字 — 标题命中 + 中字 OK",
      title: "狂飙",
      seasons: [1],
    });
    expect(result.candidateId).toBe("c-42");

    // The model only receives what we feed it — verify the prompt instructs
    // copying the bracketed id verbatim AND that the summary line carries the id
    // (otherwise the model has nothing real to copy, the 狂飙 title-as-id bug).
    const prompt = model.doGenerateCalls[0]!.prompt;
    const system = prompt.find((m) => m.role === "system")?.content ?? "";
    const user = prompt
      .filter((m) => m.role === "user")
      .flatMap((m) => m.content)
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    expect(system).toContain("从某个候选行的 [id] 里原样复制");
    expect(system).toContain("禁止填标题");
    expect(user).toContain("[A] [c-42] 狂飙.S01E01.1080p.中字");
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
      summary: "[B] [c-9] 流浪地球 4K",
      title: "流浪地球",
      year: 2019,
    });
    expect(result.candidateId).toBe("c-9");
  });

  it("tells the model to copy candidateId from the [id] bracket (movie twin)", async () => {
    const model = textModel('{"candidateId":"c-9","reasoning":"片名年份都一致"}');
    const result = await arbitrateMovieSelection({
      model,
      summary: "[B] [c-9] 流浪地球 4K — 标题命中，但发行名未带年份",
      title: "流浪地球",
      year: 2019,
    });
    expect(result.candidateId).toBe("c-9");

    const prompt = model.doGenerateCalls[0]!.prompt;
    const system = prompt.find((m) => m.role === "system")?.content ?? "";
    const user = prompt
      .filter((m) => m.role === "user")
      .flatMap((m) => m.content)
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    expect(system).toContain("从某个候选行的 [id] 里原样复制");
    expect(system).toContain("禁止填标题");
    expect(user).toContain("[B] [c-9] 流浪地球 4K");
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
describe("arbitrateDiagnosis — 功能4 nextCandidateId (批量候选)", () => {
  it("returns nextCandidateId when the model picks the next candidate", async () => {
    const result = await arbitrateDiagnosis({
      model: textModel('{"action":"retry_other","reasoning":"季错","nextCandidateId":"c-7"}'),
      summary: "季外集数: S02E01",
      title: "狂飙",
      remainingCandidates: [
        { id: "c-1", title: "狂飙.S01E01.1080p.中字", grade: "A" },
        { id: "c-7", title: "狂飙 第一季 mkv", grade: "B" },
      ],
      triedIds: ["c-1"],
    });
    expect(result.action).toBe("retry_other");
    expect(result.nextCandidateId).toBe("c-7");
  });

  it("returns null nextCandidateId when the model provides none", async () => {
    const result = await arbitrateDiagnosis({
      model: textModel('{"action":"abandon","reasoning":"没了"}'),
      summary: "whatever",
      title: "狂飙",
      remainingCandidates: [{ id: "c-9", title: "x", grade: "B" }],
    });
    expect(result.action).toBe("abandon");
    expect(result.nextCandidateId).toBeNull();
  });

  it("keeps working without remainingCandidates (backward compat)", async () => {
    const result = await arbitrateDiagnosis({
      model: textModel('{"action":"accept","reasoning":"有核心集"}'),
      summary: "S01E01 在",
      title: "狂飙",
    });
    expect(result.action).toBe("accept");
    expect(result.nextCandidateId).toBeNull();
  });
});

describe("arbitrateEpisodeMapping — 功能2 集数映射仲裁", () => {
  it("maps unparsed files to episode codes", async () => {
    const result = await arbitrateEpisodeMapping({
      model: textModel(
        '{"mapping":{"01.mp4":"S01E01","02.mp4":"S01E02"},"unmapped":["花絮.mkv"],"reasoning":"纯数字按序"}',
      ),
      unparsedFiles: ["01.mp4", "02.mp4", "花絮.mkv"],
      title: "狂飙",
      seasons: [1],
      knownEpisodeRange: { min: 1, max: 39 },
    });
    expect(result.mapping).toEqual({ "01.mp4": "S01E01", "02.mp4": "S01E02" });
    expect(result.unmapped).toEqual(["花絮.mkv"]);
  });

  it("drops hallucinated filenames and malformed codes", async () => {
    const result = await arbitrateEpisodeMapping({
      model: textModel(
        '{"mapping":{"01.mp4":"S01E01","不存在.mkv":"S01E99","03.mp4":"3"},"unmapped":[],"reasoning":"x"}',
      ),
      unparsedFiles: ["01.mp4", "03.mp4"],
      title: "狂飙",
      seasons: [1],
      knownEpisodeRange: { min: 1, max: 39 },
    });
    expect(result.mapping).toEqual({ "01.mp4": "S01E01" }); // 幻觉 & 坏 code 被丢
    expect(result.unmapped).toEqual([]);
  });

  it("degrades to an empty mapping on unparseable output (safe fallback)", async () => {
    const result = await arbitrateEpisodeMapping({
      model: textModel("not json"),
      unparsedFiles: ["01.mp4"],
      title: "狂飙",
      seasons: [1],
      knownEpisodeRange: { min: 1, max: 39 },
    });
    expect(result.mapping).toEqual({});
    expect(result.unmapped).toEqual([]);
  });
});