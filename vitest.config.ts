import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "workers/**/*.test.ts", "site/**/*.test.mjs"],
    environment: "node",
    passWithNoTests: false,
    // 网盘写操作后的「退避重读探测」(sandbox.probeSettle)在测试里关闭:
    // 退避会让 18 个测试文件被拖到超时。0 = 只做一次即时重读、不等待、不打日志。
    env: {
      MEDIA_TRACK_PROBE_DELAY_MS: "0",
    },
  },
});
