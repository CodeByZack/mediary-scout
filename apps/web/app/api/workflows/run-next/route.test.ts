import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, connection: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("../../../../lib/workflow-runtime", () => ({
  runNextQueuedWorkflow: vi.fn().mockResolvedValue({ status: "idle" }),
}));

import { GET, POST } from "./route";
import { runNextQueuedWorkflow } from "../../../../lib/workflow-runtime";

function request(method: "GET" | "POST") {
  return new NextRequest("http://localhost/api/workflows/run-next", {
    method,
  });
}

describe("/api/workflows/run-next", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("MEDIA_TRACK_DEMO_MODE", "");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("rejects demo-mode requests without running the worker", async () => {
    vi.stubEnv("MEDIA_TRACK_DEMO_MODE", "1");

    const response = await GET(request("GET"));

    expect(response.status).toBe(403);
    expect(runNextQueuedWorkflow).not.toHaveBeenCalled();
  });

  it("runs the worker on GET", async () => {
    const response = await GET(request("GET"));

    expect(response.status).toBe(200);
    expect(runNextQueuedWorkflow).toHaveBeenCalledOnce();
  });

  it("runs the worker on POST", async () => {
    const response = await POST(request("POST"));

    expect(response.status).toBe(200);
    expect(runNextQueuedWorkflow).toHaveBeenCalledOnce();
  });
});
