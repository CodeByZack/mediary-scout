export interface WorkflowRuntimeEnv extends Record<string, string | undefined> {
  MEDIA_TRACK_WORKFLOW_ADAPTER?: string;
  MEDIA_TRACK_STORAGE_ADAPTER?: string;
  MEDIA_TRACK_AGENT_ADAPTER?: string;
}

/** The only valid agent adapters. `real` (a past compose typo) is NOT one — it
 *  passes silently then the worker can never drain the queue. */
export const VALID_AGENT_ADAPTERS = ["vercel-ai", "fake"] as const;
const VALID_AGENT_ADAPTER_SET: ReadonlySet<string> = new Set(VALID_AGENT_ADAPTERS);

/**
 * Boot-time + config-time runtime validation. Fail FAST and LOUD on a misconfig
 * (e.g. MEDIA_TRACK_AGENT_ADAPTER=real) instead of silently never draining the
 * queue. Used by instrumentation.register() at startup AND by a test that parses
 * docker-compose.yml — so a bad value can never ship undetected again.
 */
export function validateRuntimeConfig(env: WorkflowRuntimeEnv): void {
  const agent = env.MEDIA_TRACK_AGENT_ADAPTER;
  if (agent !== undefined && agent !== "" && !VALID_AGENT_ADAPTER_SET.has(agent)) {
    throw new Error(
      `MEDIA_TRACK_AGENT_ADAPTER_INVALID: "${agent}" — must be one of ${VALID_AGENT_ADAPTERS.join(", ")}.`,
    );
  }
  assertWorkflowAgentAdapterPolicy(env);
}

export function assertWorkflowAgentAdapterPolicy(env: WorkflowRuntimeEnv): void {
  // 方案 A (2026-08-10): 真实搜索源 (pansou) 不再强制 vercel-ai —— 真实 PanSou
  // 搜索 + fake 网盘 + 确定性脚本 stub 是受支持的 dev/preview 组合 (改名前功能
  // 全链路验证用), 零 LLM 调用。只有 LIVE 115 存储仍强制 vercel-ai: 真实盘绝
  // 不能拿脚本/stub 去跑 (会误转存、错入库)。
  const usesLiveStorage = env.MEDIA_TRACK_STORAGE_ADAPTER === "115";
  if (!usesLiveStorage) {
    return;
  }

  if (env.MEDIA_TRACK_AGENT_ADAPTER === "vercel-ai") {
    return;
  }

  throw new Error(
    "MEDIA_TRACK_AGENT_ADAPTER_REQUIRED_FOR_LIVE_WORKFLOW: set MEDIA_TRACK_AGENT_ADAPTER=vercel-ai when MEDIA_TRACK_STORAGE_ADAPTER=115 (real drive).",
  );
}
