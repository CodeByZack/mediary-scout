import { describe, expect, it } from "vitest";
import { FakeResourceProvider } from "../src/fakes.js";

describe("FakeResourceProvider catch-all (defaultKeywordResult)", () => {
  it("known keyword still returns its configured candidates", async () => {
    const provider = new FakeResourceProvider({
      keywordResults: { "剧名 4K": [{ title: "剧名 S01E01-S01E12 4K" }] },
    });
    const snapshot = await provider.search({ keyword: "剧名 4K" });
    expect(snapshot.candidates.map((c) => c.title)).toEqual(["剧名 S01E01-S01E12 4K"]);
  });

  it("unknown keyword without catch-all stays empty (existing behavior)", async () => {
    const provider = new FakeResourceProvider({ keywordResults: {} });
    const snapshot = await provider.search({ keyword: "随便搜" });
    expect(snapshot.candidates).toEqual([]);
  });

  it("unknown keyword with static catch-all returns the fallback candidate", async () => {
    const provider = new FakeResourceProvider({
      keywordResults: {},
      defaultKeywordResult: { title: "兜底候选", source: "fake" },
    });
    const snapshot = await provider.search({ keyword: "随便搜" });
    expect(snapshot.candidates).toHaveLength(1);
    expect(snapshot.candidates[0]!.title).toBe("兜底候选");
    expect(snapshot.candidates[0]!.source).toBe("fake");
  });

  it("function catch-all receives the keyword and may return multiple candidates", async () => {
    const provider = new FakeResourceProvider({
      keywordResults: {},
      defaultKeywordResult: (keyword) => [
        { title: `${keyword} S01E01-S01E24 4K`, source: "fake" },
        { title: `${keyword} 第一季 1080P`, source: "fake" },
      ],
    });
    const snapshot = await provider.search({ keyword: "生化危机：爆发夜" });
    expect(snapshot.candidates.map((c) => c.title)).toEqual([
      "生化危机：爆发夜 S01E01-S01E24 4K",
      "生化危机：爆发夜 第一季 1080P",
    ]);
  });

  it("keywordErrors still win over catch-all", async () => {
    const provider = new FakeResourceProvider({
      keywordResults: {},
      keywordErrors: { boom: "provider down" },
      defaultKeywordResult: () => ({ title: "兜底", source: "fake" }),
    });
    await expect(provider.search({ keyword: "boom" })).rejects.toThrow("provider down");
  });
});