import { describe, expect, it } from "vitest";
import { resolveRuntimeMode, applyRuntimeMode } from "./runtime-mode";

describe("resolveRuntimeMode", () => {
  it("defaults to normal", () => {
    const r = resolveRuntimeMode(undefined);
    expect(r.storageAdapter).toBe("115");
    expect(r.workflowAdapter).toBe("pansou");
    expect(r.agentAdapter).toBe("vercel-ai");
    expect(r.demoMode).toBe(false);
    expect(r.demoSeed).toBe(false);
  });

  it("resolves fake", () => {
    const r = resolveRuntimeMode("fake");
    expect(r.storageAdapter).toBe("fake");
    expect(r.workflowAdapter).toBe("fake");
    expect(r.agentAdapter).toBe("fake");
    expect(r.demoMode).toBe(false);
    expect(r.demoSeed).toBe(false);
  });

  it("resolves demo", () => {
    const r = resolveRuntimeMode("demo");
    expect(r.storageAdapter).toBe("fake");
    expect(r.workflowAdapter).toBe("fake");
    expect(r.agentAdapter).toBe("fake");
    expect(r.demoMode).toBe(true);
    expect(r.demoSeed).toBe(true);
  });

  it("unknown values default to normal", () => {
    const r = resolveRuntimeMode("banana");
    expect(r.storageAdapter).toBe("115");
    expect(r.demoMode).toBe(false);
  });
});

describe("applyRuntimeMode", () => {
  it("sets all legacy env vars from normal", () => {
    const env: Record<string, string | undefined> = {};
    applyRuntimeMode(env);
    expect(env.MEDIA_TRACK_STORAGE_ADAPTER).toBe("115");
    expect(env.MEDIA_TRACK_WORKFLOW_ADAPTER).toBe("pansou");
    expect(env.MEDIA_TRACK_AGENT_ADAPTER).toBe("vercel-ai");
    expect(env.MEDIA_TRACK_DEMO_MODE).toBe("0");
    expect(env.NEXT_PUBLIC_MEDIA_TRACK_DEMO_MODE).toBe("0");
    expect(env.MEDIA_TRACK_DEMO_SEED).toBe("0");
    expect(env.MEDIA_TRACK_SEARCH_PROVIDER).toBe("tmdb");
  });

  it("sets all legacy env vars from fake", () => {
    const env: Record<string, string | undefined> = { MEDIA_TRACK_MODE: "fake" };
    applyRuntimeMode(env);
    expect(env.MEDIA_TRACK_STORAGE_ADAPTER).toBe("fake");
    expect(env.MEDIA_TRACK_WORKFLOW_ADAPTER).toBe("fake");
    expect(env.MEDIA_TRACK_AGENT_ADAPTER).toBe("fake");
    expect(env.MEDIA_TRACK_DEMO_MODE).toBe("0");
    expect(env.NEXT_PUBLIC_MEDIA_TRACK_DEMO_MODE).toBe("0");
    expect(env.MEDIA_TRACK_DEMO_SEED).toBe("0");
    expect(env.MEDIA_TRACK_SEARCH_PROVIDER).toBe("demo");
  });

  it("sets all legacy env vars from demo", () => {
    const env: Record<string, string | undefined> = { MEDIA_TRACK_MODE: "demo" };
    applyRuntimeMode(env);
    expect(env.MEDIA_TRACK_STORAGE_ADAPTER).toBe("fake");
    expect(env.MEDIA_TRACK_WORKFLOW_ADAPTER).toBe("fake");
    expect(env.MEDIA_TRACK_AGENT_ADAPTER).toBe("fake");
    expect(env.MEDIA_TRACK_DEMO_MODE).toBe("1");
    expect(env.NEXT_PUBLIC_MEDIA_TRACK_DEMO_MODE).toBe("1");
    expect(env.MEDIA_TRACK_DEMO_SEED).toBe("1");
    expect(env.MEDIA_TRACK_SEARCH_PROVIDER).toBe("demo");
  });
});
