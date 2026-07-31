import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { LIVE_PRICE_MONTHS, SANDBOX_PRICE_MONTHS, priceMonthsFor } from "./paddle-event.js";

/**
 * Paddle 上线配置的护栏。
 *
 * 今晚出了一次真实事故:切 live 时我列了「PADDLE_ENVIRONMENT / PADDLE_API_KEY /
 * 价格白名单」三项,**漏了 PADDLE_WEBHOOK_SECRET**。前三项全对 → 交易能创建、
 * 结账窗能开、用户能付款 → 但 webhook 全部 401 invalid signature → **钱照收,
 * 货不发,而且服务端不报任何错**。用户付了 ¥45 看到「尚未开通」。
 *
 * 更糟的是我在同一晚犯了第二次同类错误:从 main 直接 wrangler deploy,而
 * PADDLE_ENVIRONMENT=production 那个改动还在未合并的分支里 —— 把生产**打回了
 * sandbox**。
 *
 * 两次的共性:**生产状态与代码状态脱钩,而没有任何东西会喊停。**
 * 这个文件的作用就是让测试而不是我的记忆来守这条线。
 */
describe("Paddle 上线配置护栏", () => {
  const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const envMatch = wrangler.match(/"PADDLE_ENVIRONMENT"\s*:\s*"([^"]*)"/);

  it("wrangler.jsonc 里 PADDLE_ENVIRONMENT 有显式值", () => {
    // 不设 = undefined = priceMonthsFor 走 live 分支。那不该靠"缺省恰好对"。
    expect(envMatch).not.toBeNull();
    expect(envMatch?.[1]).toMatch(/^(sandbox|production)$/);
  });

  it("环境是 production 时,live 白名单必须非空", () => {
    // 空表 → priceMonthsFor 返回 null → checkout 与 webhook 双双 503。
    // 那是 fail-closed(不丢钱),但对用户就是"买不了",必须在测试层拦住。
    if (envMatch?.[1] === "production") {
      expect(Object.keys(LIVE_PRICE_MONTHS).length).toBeGreaterThan(0);
      expect(priceMonthsFor("production")).not.toBeNull();
    }
  });

  it("清单式提醒:切环境要同时换四项,不是三项", () => {
    // 这条断言的价值不在逻辑,而在**它写在测试里**——下次谁改
    // PADDLE_ENVIRONMENT,这份清单就会出现在他眼前。
    const CHECKLIST = [
      "PADDLE_ENVIRONMENT", // wrangler.jsonc(vars,走 git)
      "PADDLE_API_KEY", // secret —— sandbox key 配 production 会 401
      "PADDLE_WEBHOOK_SECRET", // secret —— **漏了它就是钱照收货不发**
      "PADDLE_CLIENT_TOKEN", // secret —— live token 打 sandbox 环境,结账窗必失败
    ];
    expect(CHECKLIST).toHaveLength(4);
    // 四项里有三项是 secret,不在代码里 —— 所以代码测试**测不到它们的真实值**。
    // 这条护栏只能提醒,不能验证。真正的验证是部署后打一次真实 webhook。
    expect(CHECKLIST.filter((k) => k !== "PADDLE_ENVIRONMENT")).toHaveLength(3);
  });

  it("live 与 sandbox 的 price_id 集合不重叠", () => {
    // 两套环境的 id 完全不同。若出现重叠,说明有人把 sandbox 的 id 粘到了 live 表
    // (或反之)—— 那会让一个环境的白名单在另一个环境静默失效。
    const live = new Set(Object.keys(LIVE_PRICE_MONTHS));
    for (const id of Object.keys(SANDBOX_PRICE_MONTHS)) {
      expect(live.has(id)).toBe(false);
    }
  });

  it("两边档位月数一致", () => {
    // 不一致 → sandbox 测通的路径到 live 变 400,而所有自动化测试都是绿的。
    expect(Object.values(SANDBOX_PRICE_MONTHS).sort()).toEqual(
      Object.values(LIVE_PRICE_MONTHS).sort(),
    );
  });
});
