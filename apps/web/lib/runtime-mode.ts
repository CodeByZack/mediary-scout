/**
 * MEDIA_TRACK_MODE 统一运行模式解析器。
 *
 * 替代以下 6 个独立变量：
 *   MEDIA_TRACK_STORAGE_ADAPTER   (fake / 115)
 *   MEDIA_TRACK_WORKFLOW_ADAPTER  (fake / pansou)
 *   MEDIA_TRACK_AGENT_ADAPTER     (fake / vercel-ai)
 *   MEDIA_TRACK_DEMO_MODE         (1 / 0)
 *   NEXT_PUBLIC_MEDIA_TRACK_DEMO_MODE (1 / 0)
 *   MEDIA_TRACK_DEMO_SEED         (1 / 0)
 *
 * 三个值：
 *   normal (默认) — 真实 LLM + 真实网盘 + 真实搜索
 *   fake         — stub LLM + 假网盘 + 真实 TMDB 搜索（零配置零费用跑通真实剧集，不碰真实网盘）
 *   demo         — 只读演示站（固定示例库 + 假网盘 + 禁止写操作 + 种子数据）
 */

export type RuntimeMode = "normal" | "fake" | "demo";

export interface ResolvedMode {
  storageAdapter: string;
  workflowAdapter: string;
  agentAdapter: string;
  searchProvider: string;
  demoMode: boolean;
  demoSeed: boolean;
}

export function resolveRuntimeMode(raw: string | undefined): ResolvedMode {
  const mode: RuntimeMode =
    raw === "fake" || raw === "demo" ? raw : "normal";

  switch (mode) {
    case "fake":
      return {
        storageAdapter: "fake",
        workflowAdapter: "fake",
        agentAdapter: "fake",
        // fake ≈ 零费用自用：搜索保持真实 TMDB（免费、无需 key），
        // 用户能搜到真实剧集并跑通全流程；只有候选/网盘/LLM 是假的。
        searchProvider: "tmdb",
        demoMode: false,
        demoSeed: false,
      };
    case "demo":
      return {
        storageAdapter: "fake",
        workflowAdapter: "fake",
        agentAdapter: "fake",
        // demo = 公开演示站：用固定示例库（demo-candidates.ts），
        // 陌生人无需 TMDB key 也能体验，且禁止一切写操作。
        searchProvider: "demo",
        demoMode: true,
        demoSeed: true,
      };
    case "normal":
    default:
      return {
        storageAdapter: "115",
        workflowAdapter: "pansou",
        agentAdapter: "vercel-ai",
        searchProvider: "tmdb",
        demoMode: false,
        demoSeed: false,
      };
  }
}

/**
 * 早期初始化：读 MEDIA_TRACK_MODE，设回旧变量。
 * 所有现有代码继续读旧变量，无需改动。
 *
 * 必须在任何适配器创建之前调用（instrumentation.ts）。
 */
export function applyRuntimeMode(env: Record<string, string | undefined>): void {
  const mode = env.MEDIA_TRACK_MODE;
  console.log(`[runtime-mode] applyRuntimeMode called, MEDIA_TRACK_MODE="${mode}"`);
  
  const resolved = resolveRuntimeMode(mode);
  
  console.log(`[runtime-mode] resolved: storage=${resolved.storageAdapter}, workflow=${resolved.workflowAdapter}, agent=${resolved.agentAdapter}, demo=${resolved.demoMode}`);
  
  env.MEDIA_TRACK_STORAGE_ADAPTER = resolved.storageAdapter;
  env.MEDIA_TRACK_WORKFLOW_ADAPTER = resolved.workflowAdapter;
  env.MEDIA_TRACK_AGENT_ADAPTER = resolved.agentAdapter;
  env.MEDIA_TRACK_DEMO_MODE = resolved.demoMode ? "1" : "0";
  env.NEXT_PUBLIC_MEDIA_TRACK_DEMO_MODE = resolved.demoMode ? "1" : "0";
  env.MEDIA_TRACK_DEMO_SEED = resolved.demoSeed ? "1" : "0";
  env.MEDIA_TRACK_SEARCH_PROVIDER = resolved.searchProvider;
  
  console.log(`[runtime-mode] applied. MEDIA_TRACK_AGENT_ADAPTER="${env.MEDIA_TRACK_AGENT_ADAPTER}"`);
}
