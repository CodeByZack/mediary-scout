/**
 * 创建 Paddle 交易(结账的起点)。
 *
 * **为什么必须由我方创建交易,而不是让 Paddle 自己生成:**
 * webhook 要知道「这笔付款属于哪个登录账号」。唯一可靠的载体是交易的
 * `custom_data.account_email` —— 而它只能在创建交易时写入。
 *
 * 实测确认(sandbox 真实事件):`transaction.completed` 的 data 里**没有嵌套的
 * customer 对象**,只有 `customer_id`。所以「从 payload 直接拿邮箱」这条路不存在;
 * 而 `custom_data` 确实会原样透传到 webhook。
 *
 * 另一件实测确认的事:**显式传 `checkout.url` 会覆盖账号级的 default payment
 * link**。这让同一个 Paddle 账号能承载多个产品 —— 各自传自己的域名,default
 * 填谁都不生效。
 */

import type { PriceMonthsMap } from "./paddle-event.js";

export interface PaddleApi {
  createTransaction(input: {
    priceId: string;
    accountEmail: string;
    checkoutUrl: string;
  }): Promise<{ transactionId: string; checkoutUrl: string }>;

  /**
   * 查这个邮箱有没有**已付款但我们还没入账**的交易。
   *
   * 为什么需要它:webhook 是唯一的入账通道,但它会延迟(微信支付延迟捕获,
   * 官方说可能长达 10 分钟)、会重试、也可能因配置错误而全部失败 —— 这三件事
   * 都真实发生过。只看 entitlements 的话,这段时间用户看到的是「尚未开通」,
   * 而他刚刚才付过钱。那是会让人立刻开退款争议的体验。
   *
   * 返回 `paid`/`completed` 状态的交易 ID 列表。**只用于显示「正在开通」提示,
   * 绝不用于发放时长** —— 发放只认验过签的 webhook,否则任何人都能靠伪造
   * 交易状态白拿时长。
   */
  listPaidTransactionIds(accountEmail: string): Promise<string[]>;
}

/** 真实 Paddle API 客户端。sandbox 与 live 的 base URL 不同。 */
export function createPaddleApi(input: {
  apiKey: string;
  /** "sandbox" | "production"。 */
  environment: string;
}): PaddleApi {
  const base =
    input.environment.trim().toLowerCase() === "sandbox"
      ? "https://sandbox-api.paddle.com"
      : "https://api.paddle.com";
  return {
    async createTransaction({ priceId, accountEmail, checkoutUrl }) {
      const res = await fetch(`${base}/transactions`, {
        method: "POST",
        // 超时是必需的,不是保险:没有它,上游抖动会让请求长时间挂起、占用
        // worker 并发额度并放大故障面。同仓其它外部调用(cf-api 10s、
        // magic-link 5s、turnstile 5s)都设了。创建交易走的是用户点「购买」
        // 的同步路径,10s 已经比人能忍的等待更长。
        signal: AbortSignal.timeout(10_000),
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          items: [{ price_id: priceId, quantity: 1 }],
          collection_mode: "automatic",
          // webhook 靠这个把付款关联到登录账号 —— 见本文件头部注释。
          custom_data: { account_email: accountEmail },
          // 显式指定,不依赖账号级 default(那个可能指向别的产品)。
          checkout: { url: checkoutUrl },
        }),
      });
      if (!res.ok) {
        // 不把 Paddle 的响应体透给客户端(可能含内部细节);只留状态码给日志。
        throw new Error(`paddle createTransaction failed: ${res.status}`);
      }
      const body = (await res.json()) as {
        data?: { id?: unknown; checkout?: { url?: unknown } | null };
      };
      const transactionId = typeof body.data?.id === "string" ? body.data.id : "";
      const url = typeof body.data?.checkout?.url === "string" ? body.data.checkout.url : "";
      if (transactionId === "" || url === "") {
        throw new Error("paddle createTransaction returned no id/checkout url");
      }
      return { transactionId, checkoutUrl: url };
    },

    async listPaidTransactionIds(accountEmail) {
      // Paddle 没有「按邮箱查交易」的直接参数,得先找 customer。
      const cRes = await fetch(
        `${base}/customers?email=${encodeURIComponent(accountEmail)}&status=active`,
        { headers: { authorization: `Bearer ${input.apiKey}` } },
      );
      if (!cRes.ok) return [];
      const cBody = (await cRes.json()) as { data?: Array<{ id?: unknown }> };
      const customerId = cBody.data?.[0]?.id;
      if (typeof customerId !== "string" || customerId === "") return [];

      // paid = 已捕获但尚未 completed;completed = 已完成。两者都意味着钱已经到了。
      const tRes = await fetch(
        `${base}/transactions?customer_id=${encodeURIComponent(customerId)}&status=paid,completed&per_page=20`,
        { headers: { authorization: `Bearer ${input.apiKey}` } },
      );
      if (!tRes.ok) return [];
      const tBody = (await tRes.json()) as { data?: Array<{ id?: unknown }> };
      return (tBody.data ?? [])
        .map((t) => t.id)
        .filter((id): id is string => typeof id === "string" && id !== "");
    },
  };
}

/** 校验 price_id 是否属于我方白名单。
 *
 *  **不能让客户端随便传 price_id**:那等于允许任何人拿一个自己知道的、更便宜的
 *  price 去结账。只放行白名单里的档位 —— 与 webhook 用的是同一份表,天然一致。 */
export function isKnownPriceId(priceId: string, priceMonths: PriceMonthsMap): boolean {
  // Object.hasOwn 而非 `in`/下标:普通对象字面量的原型链上有 toString 等,
  // 下标访问会返回 function 而非 undefined(webhook 侧踩过这个坑)。
  return priceId !== "" && Object.hasOwn(priceMonths, priceId);
}
