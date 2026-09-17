import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, connection: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("../../../../lib/workflow-runtime", () => ({
  runScheduledType3: vi.fn().mockResolvedValue({ status: "idle" }),
}));

import { GET, POST } from "./route";
import { runScheduledType3 } from "../../../../lib/workflow-runtime";

function request(method: "GET" | "POST", options?: { force?: boolean }) {
  const url = new URL("http://localhost/api/workflows/run-type3");
  if (options?.force) url.searchParams.set("force", "1");
  return new NextRequest(url, { method });
}

describe("/api/workflows/run-type3", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("MEDIA_TRACK_DEMO_MODE", "");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("rejects forced demo-mode sweeps without running patrol", async () => {
    vi.stubEnv("MEDIA_TRACK_DEMO_MODE", "1");

    const response = await GET(request("GET", { force: true }));

    expect(response.status).toBe(403);
    expect(runScheduledType3).not.toHaveBeenCalled();
  });

  it("runs patrol with force=true", async () => {
    const response = await GET(request("GET", { force: true }));

    expect(response.status).toBe(200);
    expect(runScheduledType3).toHaveBeenCalledWith({ force: true });
  });

  it("runs patrol with force=false by default", async () => {
    const response = await GET(request("GET"));

    expect(response.status).toBe(200);
    expect(runScheduledType3).toHaveBeenCalledWith({ force: false });
  });

  it("runs patrol on POST", async () => {
    const response = await POST(request("POST"));

    expect(response.status).toBe(200);
    expect(runScheduledType3).toHaveBeenCalledWith({ force: false });
  });
});
