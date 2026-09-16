# media-track TMDB 代理 Worker

参考实现：把 TMDB 元数据请求经此 Worker 代理出海 + KV 缓存（电影 7d / 电视·搜索 1h），只代理白名单元数据路径。

**从 #38 起这份 Worker 不再是"作者托管的公共兜底"**——作者不再代持任何人的 TMDB key。想用的话自己部署到 Cloudflare 账号，填自己的 token。MediaTrack 侧把 `TMDB_BASE_URL` 指过来即可。

## 认证方式（两种，任选）

| 路径 | 谁用 | 说明 |
|---|---|---|
| `Authorization: Bearer <token>` 请求头 | 新部署 | MediaTrack 在 `TMDB_BASE_URL` 指过来后自动带头；token 全程在你的服务器和 proxy 之间，不落 CF secret |
| `TMDB_READ_TOKEN` CF secret | 旧部署 | 向后兼容，不用改 app 配置；cron 预热也只走这条（`scheduled()` 无 request 上下文） |

优先级：**请求头 > secret**。两边都没 → 401。

## CORS（可选）

MediaTrack 的 Web UI 全 server-side 调用，**不需要 CORS**。只有你自己跑一份落地页（像作者原来的 mediaryscout.app 那样浏览器端 fetch trending）才需要配。

- 默认允许 `http://localhost:8788` / `http://127.0.0.1:8788`（本地开发）
- 生产落地页：在 CF Worker → Settings → Variables 加 `CORS_ALLOWED_ORIGINS=https://mediary.dkai.cc.cd`（逗号分隔多个）
- 不配 = 只允许 localhost

## 部署（需 `npx wrangler`，已登录）

```bash
# 1. 建 KV namespace，把输出的 id 填回 wrangler.jsonc 的 kv_namespaces[0].id
npx wrangler kv namespace create TMDB_CACHE --config workers/tmdb-proxy/wrangler.jsonc

# 2.（可选）写入你自己的 TMDB token 到 Worker secret
#    只想走请求头路径的话，这步可以跳过
npx wrangler secret put TMDB_READ_TOKEN --config workers/tmdb-proxy/wrangler.jsonc
# 提示时粘贴 v3 auth key 或 v4 read token

# 3. 部署
npx wrangler deploy --config workers/tmdb-proxy/wrangler.jsonc
```

`wrangler.jsonc` 里声明了 custom domain（`tmdb-proxy.mediaryscout.app`）和 KV namespace id——那是作者那份专用值。**自部署用户请改三处再部署**：

- `name` → 你的 Worker 名（CF 全局唯一）
- `kv_namespaces[0].id` → 第 1 步输出的 namespace id
- `routes[0].pattern` → 你自己的域名（或先删掉这段，用 workers.dev URL）

### 部署到 MediaTrack 侧

在 MediaTrack 设置页的 **TMDB 元数据** 卡片，除了填 token，还要填：

- **API Base URL**：`https://<你刚部署的 proxy URL>`

保存后请求链路变成：`MediaTrack → 你的 proxy → api.themoviedb.org`。完整教程见 [docs/tmdb-setup.md](../../docs/tmdb-setup.md)。

## 校验

```bash
# 带 Bearer 头走新路径：第一次 X-Cache: MISS；第二次 X-Cache: HIT
curl -s -D - -H "Authorization: Bearer $YOUR_TOKEN" \
  "https://<部署URL>/movie/278?language=zh-CN" -o /dev/null | grep -i x-cache
curl -s -D - -H "Authorization: Bearer $YOUR_TOKEN" \
  "https://<部署URL>/movie/278?language=zh-CN" -o /dev/null | grep -i x-cache

# 不带任何凭据 → 401（不再是 500 "misconfigured"）
curl -s -o /dev/null -w "%{http_code}\n" "https://<部署URL>/movie/278"

# 白名单外路径 → 404
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $YOUR_TOKEN" \
  "https://<部署URL>/account/x"
```

## 防滥用

- **KV 缓存**是主力：绝大多数重复查询不回源，你的 key 调用量近乎不增。
- **限流**：在 Cloudflare dashboard → 该 Worker → Settings 加 Rate limiting 规则（建议 per-IP 60 req/min）。

## 测试

纯函数 handler（`src/handler.ts`）依赖全注入（KV/fetch），单元测试 `src/handler.test.ts`；入口 `src/index.ts` 的鉴权优先级单测在 `src/index.test.ts`。均由仓库根 `npm test`（vitest）自动发现。

类型：`npx tsc -p workers/tmdb-proxy/tsconfig.json --noEmit`。
