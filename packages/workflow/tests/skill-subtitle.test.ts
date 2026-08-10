import { describe, expect, it } from "vitest";
import { readSkillSection, skillIndexForAgent, SKILL_SECTION_NAMES } from "../src/acquisition-v2/skill.js";

describe("subtitle skill section", () => {
  it("is a registered section", () => {
    expect(SKILL_SECTION_NAMES).toContain("subtitle");
  });

  it("readSkillSection('subtitle') returns the subtitle playbook body", () => {
    const body = readSkillSection("subtitle");
    expect(body).toContain("viewSubtitleSnapshot");
    expect(body).toContain("transferSubtitle");
    expect(body).toMatch(/rename|重命名/); // the rename exception
    expect(body).toMatch(/soft|不阻塞|does not block/i); // soft-fail philosophy
  });

  it("teaches the hard order: renameSubtitle AFTER renameVideo (subtitle prefix follows the canonical video name)", () => {
    const body = readSkillSection("subtitle");
    expect(body).toMatch(/renameVideo/);
    expect(body).toMatch(/AFTER `?renameVideo|Call this AFTER|video rename comes FIRST/i);
    expect(body).not.toMatch(/ONLY files you may rename/); // videos are renamed too now
  });

  it("both movie and tv skill indexes point at the subtitle section", () => {
    const movie = skillIndexForAgent("movie");
    const tv = skillIndexForAgent("tv");
    expect(movie).toContain("subtitle");
    expect(tv).toContain("subtitle");
  });
});

describe("skillIndexForAgent — Available-sections line derives from the single source of truth", () => {
  it("lists every registered section except the OTHER agent's playbook (cannot drift)", () => {
    for (const agent of ["movie", "tv"] as const) {
      const other = agent === "movie" ? "tv" : "movie";
      const line = skillIndexForAgent(agent)
        .split("\n")
        .find((l) => l.startsWith("Available sections:"));
      expect(line).toBeDefined();
      const listed = line!
        .replace("Available sections:", "")
        .replace(/\.$/, "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .sort();
      expect(listed).toEqual([...SKILL_SECTION_NAMES].filter((s) => s !== other).sort());
    }
  });
});
