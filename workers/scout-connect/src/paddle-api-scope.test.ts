import { describe, expect, it, vi } from "vitest";
import { createPaddleApi } from "./paddle-api.js";

/**
 * listPaidTransactionIds 必须只认**我们自己**的档位。
 *
 * 真实 bug:同一个 Paddle 账号卖多个产品,而第一版只按 customer 过滤。
 * 实测踩到 —— 一个邮箱 2026-04-27 买过 "Shopify POD Profit Planner"($12),
 * 打开 Mediary Connect 控制台立刻显示「已付款 · 正在开通」,而他从没为
 * Connect 付过一分钱。
 *
 * 这个误报方向特别糟:它让一个**没付款**的人以为货在路上,于是不去付款,
 * 然后来投诉「等了半天没开通」。
 */
describe("listPaidTransactionIds 只认自己的档位", () => {
  const OURS = "pri_ours_yearly";
  const THEIRS = "pri_other_product";

  const api = (txns: unknown[]) => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/customers")) {
        return new Response(JSON.stringify({ data: [{ id: "ctm_1" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: txns }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return createPaddleApi({ apiKey: "k", environment: "production" });
  };

  it("别的产品的已付款订单 → 不算", () => {
    const a = api([{ id: "txn_other", items: [{ price: { id: THEIRS } }] }]);
    return expect(a.listPaidTransactionIds("x@y.com", [OURS])).resolves.toEqual([]);
  });

  it("我们的档位 → 算", async () => {
    const a = api([{ id: "txn_ours", items: [{ price: { id: OURS } }] }]);
    await expect(a.listPaidTransactionIds("x@y.com", [OURS])).resolves.toEqual([{ id: "txn_ours", createdAt: null }]);
  });

  it("混合时只挑我们的", async () => {
    const a = api([
      { id: "txn_other", items: [{ price: { id: THEIRS } }] },
      { id: "txn_ours", items: [{ price: { id: OURS } }] },
    ]);
    await expect(a.listPaidTransactionIds("x@y.com", [OURS])).resolves.toEqual([{ id: "txn_ours", createdAt: null }]);
  });

  it("白名单为空 → 什么都不认(不做假过滤)", async () => {
    // 空数组意味着「我们不知道自己卖什么」。那时任何过滤都是假的 ——
    // 宁可不提示,也不能拿别的产品的订单冒充。
    const a = api([{ id: "txn_ours", items: [{ price: { id: OURS } }] }]);
    await expect(a.listPaidTransactionIds("x@y.com", [])).resolves.toEqual([]);
  });

  it("透传 createdAt(时间窗口过滤用)", async () => {
    const a = api([
      { id: "txn_ours", created_at: "2026-08-01T13:02:13Z", items: [{ price: { id: OURS } }] },
    ]);
    await expect(a.listPaidTransactionIds("x@y.com", [OURS])).resolves.toEqual([
      { id: "txn_ours", createdAt: "2026-08-01T13:02:13Z" },
    ]);
  });

  it("items 缺失/畸形不炸", async () => {
    const a = api([{ id: "t1" }, { id: "t2", items: [] }, { id: "t3", items: [{ price: null }] }]);
    await expect(a.listPaidTransactionIds("x@y.com", [OURS])).resolves.toEqual([]);
  });
});
