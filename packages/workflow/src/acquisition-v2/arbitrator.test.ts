import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock generateText before importing the module under test.
vi.mock("ai", () => ({
  generateText: vi.fn(),
}));

import { generateText } from "ai";
import { arbitrateSelection } from "./arbitrator.js";

const mockGenerate = generateText as ReturnType<typeof vi.fn>;

function mockModel(): Parameters<typeof arbitrateSelection>[0]["model"] {
  return {} as any;
}

describe("arbitrateSelection parsing", () => {
  beforeEach(() => {
    mockGenerate.mockReset();
  });

  it("accepts candidateIds array (new format)", async () => {
    mockGenerate.mockResolvedValue({ text: '{"candidateIds": ["id1", "id2", "id3"], "reasoning": "ok"}' });
    const result = await arbitrateSelection({
      model: mockModel(), summary: "", title: "t", seasons: [1], maxPicks: 3,
    });
    expect(result.candidateIds).toEqual(["id1", "id2", "id3"]);
  });

  it("accepts candidateId string (backward compat with old prompt overrides)", async () => {
    mockGenerate.mockResolvedValue({ text: '{"candidateId": "id1", "reasoning": "ok"}' });
    const result = await arbitrateSelection({
      model: mockModel(), summary: "", title: "t", seasons: [1], maxPicks: 3,
    });
    expect(result.candidateIds).toEqual(["id1"]);
  });

  it("truncates to maxPicks", async () => {
    mockGenerate.mockResolvedValue({ text: '{"candidateIds": ["id1", "id2", "id3", "id4"], "reasoning": "ok"}' });
    const result = await arbitrateSelection({
      model: mockModel(), summary: "", title: "t", seasons: [1], maxPicks: 2,
    });
    expect(result.candidateIds).toEqual(["id1", "id2"]);
  });

  it("filters non-string values from array", async () => {
    mockGenerate.mockResolvedValue({ text: '{"candidateIds": ["id1", 42, null, "id2"], "reasoning": "ok"}' });
    const result = await arbitrateSelection({
      model: mockModel(), summary: "", title: "t", seasons: [1], maxPicks: 3,
    });
    expect(result.candidateIds).toEqual(["id1", "id2"]);
  });

  it("returns empty array on unparseable reply (safe decline)", async () => {
    mockGenerate.mockResolvedValue({ text: "not json at all" });
    const result = await arbitrateSelection({
      model: mockModel(), summary: "", title: "t", seasons: [1], maxPicks: 3,
    });
    expect(result.candidateIds).toEqual([]);
  });

  it("returns empty array when candidateIds is missing and candidateId is null", async () => {
    mockGenerate.mockResolvedValue({ text: '{"candidateId": null, "reasoning": "no good"}' });
    const result = await arbitrateSelection({
      model: mockModel(), summary: "", title: "t", seasons: [1], maxPicks: 3,
    });
    expect(result.candidateIds).toEqual([]);
  });
});
