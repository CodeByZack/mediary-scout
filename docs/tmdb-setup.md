# TMDB 配置指南

MediaTrack 的影视元数据（海报、集数、播出日、季集名）全部来自 [TMDB](https://www.themoviedb.org/)。
从 **v0.0.5** 起，应用不再内置公共代理兜底，**TMDB read token 必填**——没配就无法取元数据，
「获取」按钮不会工作。

本指南覆盖三件事：

1. 去 TMDB 官网申请一个 read token（免费，约 5 分钟）
2. 把它填进 MediaTrack 设置页
3. （可选，墙内环境）自建 tmdb-proxy 出海

> **English TL;DR.** Grab a free read-only TMDB token from
> [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api), paste it into
> Settings → TMDB Metadata, save. If your host can't reach
> `api.themoviedb.org` directly (mainland China), deploy
> `workers/tmdb-proxy/` to your own Cloudflare account and point
> `TMDB_BASE_URL` at it. No author-side fallback exists anymore.

---

## 目录

- [你需要准备什么](#你需要准备什么)
- [第 1 步：申请 TMDB read token](#第-1-步申请-tmdb-read-token)
- [第 2 步：填进 MediaTrack 设置页](#第-2-步填进-mediary-scout-设置页)
- [第 3 步（可选）：大陆网络自建 tmdb-proxy](#第-3-步可选大陆网络自建-tmdb-proxy)
  - [3.1 一键部署脚本](#31-一键部署脚本)
  - [3.2 配置说明](#32-配置说明)
  - [3.3 手动部署（不用脚本）](#33-手动部署不用脚本)
  - [3.4 把 MediaTrack 指过去](#34-把-mediary-scout-指过去)
- [验证配置](#验证配置)
- [常见问题](#常见问题)
- [与旧版本的差异](#与旧版本的差异)

---

## 你需要准备什么

| 项 | 必需 | 说明 |
|---|---|---|
| TMDB read token | ✅ | 官网免费申请，只读权限，不写 TMDB 数据 |
| Cloudflare 账号 | 仅场景 B 需要 | 自建 proxy 出海用；墙外直连 TMDB 无需 |

Token 只读、免费、无流量限制（TMDB 官方限流 800 req/10s，MediaTrack 一次搜索约 11 个请求，
日常使用绰绰有余）。

---

## 第 1 步：申请 TMDB read token

1. 打开 <https://www.themoviedb.org/settings/api>（需先登录 TMDB 账号；没有就注册，邮箱即可）。
2. 页面顶部有三个 tab：**API Keys** / **Auth Tokens** / **Session Tokens**。点进 **API Keys**。
3. 点 **Request**（右上角蓝色按钮），在弹出的表单里：
   - **Key Type** 选 **Read**（只要读权限，MediaTrack 不会往 TMDB 写数据）
   - **Application Name** 填任意名字（如 `mediary-scout`）
   - **Application Website** 可留空
4. 提交后页面会展示两把钥匙：
   - **v3 auth key**（32 位十六进制字符串）
   - **v4 read token**（较长的一串，形如 `eyJ0eXA...`）
5. **复制其中任意一个**存到本地密码管理器。**页面上只显示这一次**，关掉就没了——
   丢了只能重新申请。

> **⚠️ 别把 token 分享出去**：Token 是 TMDB 官方发的个人凭据，绑到你账号，别人拿去用会
> 扣你的额度并可能触发官方封禁。MediaTrack 只会用它做 read 请求，不会往外转发。

---

## 第 2 步：填进 MediaTrack 设置页

**场景 A（网络能直连 TMDB 的环境：墙外服务器、能翻墙的机器）**

1. 打开 MediaTrack → **设置** 页
2. 找到 **TMDB 元数据** 卡片
3. 在 **API Key / Token** 输入框粘贴第 1 步拿到的 token
4. 点 **保存**

保存后 UI 会显示「已配置」徽章；不用重启应用，下一次搜索/获取就生效。

---

## 第 3 步（可选）：大陆网络自建 tmdb-proxy

**症状判断**：填完 token、保存后，搜索页报 `All 1 TMDB access(es) failed: TimeoutError`
或 `ETIMEDOUT`。用浏览器打开 <https://api.themoviedb.org/3/> 也打不开——说明你所在网络
到 TMDB 的 API 主机被墙（**官网能开 ≠ API 能通**，两者是不同域名）。

这时候自建 tmdb-proxy。仓库自带一份 Cloudflare Worker 参考实现（`workers/tmdb-proxy/`）：
KV 缓存 + 出海。部署到你自己的 Cloudflare 账号后，把 MediaTrack 指过去。

### 3.1 一键部署脚本

推荐方式——填个配置文件，跑一条命令搞定全部：

```bash
cd workers/tmdb-proxy
cp deploy.config.example.json deploy.config.json
# 编辑 deploy.config.json 填入你的配置
node deploy.mjs
```

脚本会自动：
- 建 KV namespace（已存在则复用）
- 生成 wrangler.jsonc
- 设 CF secret（可选）
- 部署 Worker
- 自动验证（测两个 URL）

> **前提**：先 `npx wrangler login` 登录 Cloudflare（会弹出浏览器）

### 3.2 配置说明

`deploy.config.json` 各字段说明：

| 字段 | 必填 | 示例 | 说明 |
|---|---|---|---|
| `workerName` | ✅ | `"media-track-tmdb-proxy"` | Worker 名称，CF 全局唯一 |
| `tmdbToken` | ⚠️ | `"a2fb790c..."` | TMDB read token。留空则不设 CF secret，仅用于验证测试 |
| `storeSecret` | ❌ | `true` | `true` = 设 CF secret；`false` = 跳过，token 仅用于测试 |
| `cfApiToken` | ❌ | `""` | Cloudflare API token（可选，浏览器登录也行） |
| `corsOrigins` | ❌ | `"https://your-landing.com"` | 落地页域名（逗号分隔），跑落地页才需要 |
| `customDomain` | ❌ | `"tmdb.your-domain.com"` | 自定义域名，留空则用 workers.dev URL |
| `kvNamespace` | ❌ | `"TMDB_CACHE"` | KV namespace 名称，默认 `TMDB_CACHE` |

**三种 token 模式**：

| `tmdbToken` | `storeSecret` | 行为 |
|---|---|---|
| 有值 | `true`（默认） | 设 CF secret + 跑验证测试 |
| 有值 | `false` | 跳过 secret，仅用于验证测试 |
| 空 | 任意 | 跳过 secret，验证测试也跳过 |

### 3.3 手动部署（不用脚本）

```bash
cd workers/tmdb-proxy

# 1. 登录 Cloudflare
npx wrangler login

# 2. 建 KV namespace，复制输出的 id
npx wrangler kv namespace create TMDB_CACHE

# 3. 编辑 wrangler.jsonc
#    - name → 你的 Worker 名
#    - kv_namespaces[0].id → 第 2 步的 namespace id
#    - routes → 自定义域名（或删掉用 workers.dev）

# 4.（可选）写 TMDB token 到 Worker secret
printf 'YOUR_TOKEN' | npx wrangler secret put TMDB_READ_TOKEN

# 5.（可选）写 CORS origins
printf 'https://your-landing.com' | npx wrangler secret put CORS_ALLOWED_ORIGINS

# 6. 部署
npx wrangler deploy
```

### 3.4 把 MediaTrack 指过去

在 MediaTrack 设置页的 **TMDB 元数据** 卡片，除了填 token，还要填：

- **API Base URL**（可选字段）：`https://<你刚部署的 proxy URL>`

保存。现在请求链路变成：

```
MediaTrack → 你的 proxy（CF，出海） → api.themoviedb.org
```

Token 全程走你的服务器，不经过作者的 key。

---

## 验证配置

### 快速自检

1. **UI 徽章**：设置页 TMDB 卡片应显示「已配置」。未配置时是「未配置」，且「获取」按钮
   会提示需先配置 TMDB。
2. **搜索页**：随便搜个片名（如 `星际穿越`），能返回结果即通。
3. **curl 直连**（在容器里或宿主机上跑）：

   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" \
     -H "Authorization: Bearer $YOUR_TOKEN" \
     "https://api.themoviedb.org/3/movie/278?language=zh-CN"
   ```
   
   `200` = 直连通；`000` / `ETIMEDOUT` = 网络不通，走第 3 步；`401` = token 错或过期。

### 自建 proxy 自检

```bash
# 带 token → 200
curl -s -D - -H "Authorization: Bearer $YOUR_TOKEN" \
  "https://<你的proxyURL>/movie/278?language=zh-CN" -o /dev/null | grep -iE "http|x-cache"

# 不带 token → 401
curl -s -o /dev/null -w "%{http_code}\n" "https://<你的proxyURL>/movie/278"

# 白名单外路径 → 404
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $YOUR_TOKEN" \
  "https://<你的proxyURL>/account/x"
```

---

## 常见问题

**Q：Token 丢了怎么办？**
重新申请一个。旧的不会自动失效，但既然丢了就是明文暴露过，建议申请新的并覆盖旧的
（TMDB 后台 → API Keys → 删掉旧的那行）。

**Q：报 `401 Unauthorized`？**
Token 抄错、过期、或者被 TMDB 封了。回官网重新申请一次。

**Q：报 `All 1 TMDB access(es) failed: TimeoutError`？**
网络问题。按第 3 步自建 tmdb-proxy。

**Q：能同时配多套 token 做冗余吗？**
不行。当前设计是**单通道单 key**——填了就只用它。这是刻意的（见下方「与旧版本的差异」）。

**Q：MediaTrack 会用我的 token 做写操作吗？**
不会。只发 `GET` 请求查元数据，不会创建/修改 TMDB 数据。

**Q：token 存在哪里？**
MediaTrack 自己的 SQLite 数据库（`account_settings` 表），跟着你的数据目录走。备份数据
目录前留意它会一并导出。

**Q：deploy.mjs 报错 "Not logged in"？**
先跑 `npx wrangler login`（会弹出浏览器），登录成功后再跑脚本。

**Q：deploy.mjs 报错 "Could not find KV namespace"？**
KV namespace 已存在但脚本没找到。手动跑 `npx wrangler kv namespace list` 看输出，
确认 namespace 名称和 config 里的 `kvNamespace` 一致。

---

## 与旧版本的差异

从 v0.0.4 及更早版本升级过来注意：

| 旧行为 | 新行为 |
|---|---|
| 不填 key 也能跑，作者公共代理兜底 | **不填 key 启动即失败**，UI 显示引导文案 |
| `api.themoviedb.org` 不通时自动切到作者代理 | 不再自动切；墙内用户必须自建 tmdb-proxy |
| 用户请求消耗作者的 TMDB 配额 | 只消耗你自己的配额 |
| Token 可能藏在 CF Worker secret 里 | Token 只来自 UI 配置，单一真相源 |

**升级步骤**：

1. 先按第 1 步申请好 token
2. 升级应用
3. 打开设置页填 token
4. 墙内环境再补第 3 步

如果升级后立刻发现取元数据失败，多半是漏了第 3 步——不是应用坏了。

---

## 参考

- [TMDB API 文档](https://developer.themoviedb.org/docs/introduction)
- [TMDB API Keys 设置页](https://www.themoviedb.org/settings/api)
- 自建 proxy 参考实现：[`workers/tmdb-proxy/`](../workers/tmdb-proxy/README.md)
- 部署方式总览：[`deploy.md`](./deploy.md)
- 相关设计讨论：[Issue #38 — TMDB 配置方案重构](https://github.com/CodeByZack/mediary-scout/issues/38)
