# 方案:新增媒体类型「综艺」(variety)

> 状态:v3 **终稿已放行** · 2026-09-26 · 子代理三轮证据化评审:R1 REQUEST_CHANGES(10 项修入)
> → R2 APPROVE_WITH_COMMENTS(6 项修入,含评审员自纠 R1 引用失真)→ R3 **APPROVE,8/8 闭环,
> 可进入实施**(尾批 1 处锚点漂移 :443→:438/:501 已修)· 前置调研见 §1(线上实测经 tmdb-proxy,
> 评审员独立复测吻合;根 tsc 基线 R1/R2 各跑一次均绿)
> 姊妹文档:docsify `how-it-runs.md`(架构)、`mediary-scout-consumption-refactor-design.md`(流水线)

## 0. 摘要

- **variety 是「书架类型」,不是工作流 kind** —— 与现有 `anime` 完全同构。TMDB 上游没有综艺
  分类(media_type 只有 tv/movie;16 个 TV genre 无 Variety),判据只能是 genre `10764 真人秀`
  在入库时派生。`context.ts` 的设计不变量「kind 差异只允许出现在 4 个收口点」原样保持。
- **综艺的硬骨头已经全部做完**:第N期 Part 锚定、衍生内容黑名单、年守卫、episodeNames 四路接线
  (issue #27 的十一刀)都在 tv 管线内、与 MediaType 无关。**episode-code / grader / digest /
  season-sync / fast path 一行不改**,新类型天然继承全部综艺能力。
- 分档实施(§7 已拍板):首批 **A 分架 → C 独立网盘落点 → D 热门 feed**,合计 ≈ 2.5–3 人日;
  B 专属搜索配方**暂缓**(现有综艺就是 tv 配方,线上采得动,待观察后另立)。

## 1. 上游数据事实(2026-09-26 实测)

`GET /genre/tv/list`(权威):16 个 genre,`10764 真人秀(Reality)`、`10767 脱口秀(Talk)`,
**无「综艺/Variety」**。逐档抽查(含线上在追的三部):

| 节目 | TMDB id | genres | series `type` |
|---|---|---|---|
| 花儿与少年 | 121876 | 真人秀 | Reality |
| 中餐厅 | 91914 | 真人秀 | Reality |
| 地球超新鲜 | 296202 | 真人秀 | Reality |
| 极限挑战 | 89620 | 真人秀 | Reality |
| 奔跑吧 | 98031 | 真人秀+喜剧 | Reality |
| 密室大逃脱 | 89861 | 真人秀 | Reality |
| 喜人奇妙夜 | 257161 | 真人秀+喜剧 | Reality |

**8/8 全带 10764,判据很干净。** 结构性事实:

1. **季结构**:周更,一季 10–20 集(S2 地球超新鲜 20 集、极限挑战 S10 12 集);
   衍生内容全堆 **S0 特别篇**(地球超新鲜 178 集、极限挑战 106 集)。
   S0 已被 `prepareSeriesTarget` + `searchSeasonsFromTvDetails` 双过滤
   (`season_number > 0 && episode_count > 0`,tmdb-provider.ts:746),综艺不会把花絮当正片追。
2. **集名三形态**(全部命中 issue #27 已覆盖的六种形态,无新增):
   - `第1期上：我和你` / `第1期下：我和你` —— 地球超新鲜,严格 1 期 = 2 集;
     ⚠️ 新样本:「第5期上/下」主题名可不同 —— 锚定只认期号+上中下,不碰主题,天然兼容;
   - `第1期：龚俊…` 不分上中下 —— 机械 E(N) 即对;
   - 纯主题名 `勇闯漠河`(极限挑战 S10)—— 无期号,回退机械 E(N),周更顺序即集序。
3. **`episode_type` 字段不可用作正片/衍生标记**(实测分布只有 standard/finale/mid_season,
   S0 花絮也全标 standard)。衍生过滤继续靠现有文件名黑名单,不引入新依赖。
4. **热门 feed 的两个坑**(为 D 档预留):综艺投票数极低(地球=6、极限=14),
   anime 先例里的 `vote_count.gte=50` 会把它们全灭;经典季播剧 first_air_date 很老(极限 2015),
   `first_air_date.gte` 门槛也不适用 —— D 档应改用 `last_air_date.gte` 滚动窗口。

## 2. 设计原则与铁律

1. **variety 只出现在收口点的「①目录父级」一处**。`context.ts:21-22` 的 4 收口点 = 认领优先级表 /
   ①目录父级 / ③need 形状(computeNeed)/ ⑦落库口径(`pipeline.ts:20-31`)——**搜索配方不在名单里**,
   它是第④阶段 runAcquisition 内 `search-profile.ts` 的事,且 variety 沿 `=== "anime"` 三元链
   (:43/:49)自然回落 TV_ORIGIN_PRECEDENCE,**B 暂缓 = 配方零改动**。认领/need 形状/落库口径与 tv 共用,
   不新增 kind;UI 书架非管线范畴。
2. **movie 永不改判**(动漫铁律同款):院线动画/纪录片不动。
3. **⛔ 存量不回填改判**:分类发生在入库时,已追的综艺(现 type=tv)一律保持。
   改判若与网盘搬迁不成套 → 巡检按新落点找已存集找不到 → **整季重复转存**。
   若将来要做存量重 categorization,必须「改判 + 物理搬迁 + episode_states 校验」三件套同 PR,
   本方案明确不做。
4. **anime 与 variety 同时命中(genre 16+10764,动漫衍生番)时动漫优先** —— 归架语义上动漫架对。
5. 判据源保持单点:分类只在 `classifyMediaType` 一处发生(经 `tvMediaType` 三个入口调用),
   UI/搜索/巡检全部消费 `title.type`,不二次判 genre。

## 3. 判据落地(全部改动就这么多)

```ts
// media-classification.ts
const REALITY_GENRE_ID = 10764;        // 真人秀 —— 唯一判据(10767 脱口秀已拍板不并入,§7.1)

// 函数真实结构:movie 有独立早退守卫(:21-23,baseType 收窄 Extract<MediaType,"tv"|"movie">),
// 改动只发生在 :24 的单三元 —— 展开为 anime > variety > tv 三路,守卫原样不动:
if (input.baseType === "movie") return "movie";            // 既有守卫
if (input.genreIds.includes(ANIMATION_GENRE_ID)) return "anime";
if (input.genreIds.includes(REALITY_GENRE_ID))   return "variety";
return "tv";
```

- `domain.ts`:`export type MediaType = "movie" | "tv" | "anime" | "variety"`(+1 行)。
- 可选强化:`details.type === "Reality"` 作第二信号 —— provider 的 `TmdbTvDetails` + parse
  补一个字段(约 6 行)。**P0 不做**,genre 判据 8/8 够用;若观察期发现噪声再升 AND 判据。

## 4. 改动分档

### A 档 · 分架(必做,P0,≈ 0.5–1 人日)

| 文件 | 改动 |
|---|---|
| `packages/workflow/src/domain.ts` | union +1 |
| `packages/workflow/src/media-classification.ts` | §3 判据 |
| `packages/workflow/tests/media-classification.test.ts` | 综艺/动漫优先/movie 不改判 用例 |
| `apps/web/app/page.tsx` | 三处手写点同改,**编译口径不同**:①:456 typeLabel 三元链(「else=动漫」)——**静默**;②:444-448 分类页过滤链 + :80 `mediaType: string` 无校验(`?type=variety` 三条 if 全不命中 → 综艺页混入全类型)——**静默,编译器救不了**;③:421 `byType` 字面量 union 参数——新调用 `byType("variety")` 会报类型错,**编译器护得住,改动机械**。①②统一改 `Record<MediaType,…>` / 键集合校验;:609 showHref 调用点随 workflow-scope 扩参通过 |
| `apps/web/lib/title-hub.ts` | 手写字面量 union 不止一处::262 typeHint、:393/:408/:479(接收 title.type 于 :461/:509)全部扩 4 值。season-shaped/端点路由共四锚::170/:361 为 `!== "movie"` 排除式过滤、:438/:501 为 `=== "movie"` 海报端点路由(else 走 series resolver)——variety **四处天然全落 series 侧,零改动**(前稿「谓词并入」说法作废;:443 系误锚,R3 评审揪出、作者复读确认);`getLibraryTypeCounts`(:517)全仓无调用方 = 死导出,不顺手清 |
| `packages/workflow/src/workflow-scope.ts` | `showHref` 的 type 参数是手写字面量 union(:263-268)——MediaType 扩到 4 值后现调用点**编译爆**,参数改收 `MediaType` |
| `apps/web/components/activity-feed.tsx` | `showHref(…, run.type)`(:294,run.type=MediaType,activity-view.ts:42)——上一条改完即通过,列入防漏编译面 |
| `apps/web/lib/demo-workflow.ts / demo-session.ts / demo-candidates.ts` | union 穷举点机械补齐;**并加一条综艺演示条目(§7.4)**。⚠️ `demo-session.ts:45/:172` 是 sessionStorage 的**运行时 type 白名单**,漏改 = 综艺演示条目被静默丢弃、编译不报 |
| `apps/web/lib/demo-session.test.ts` | **硬计数**断言(:57/:146 `toHaveLength(20)`),加条目必须同步更新(CI 会红,非静默) |
| `apps/web/lib/demo-workflow.test.ts` | :24 系**下界**断言(`toBeGreaterThanOrEqual(18)`),:26-28 类型集合断言只查 movie/tv/anime 存在性 —— 加综艺条目预期不红,跑一遍确认即可 |
| `apps/web/components/trending-row.tsx` | :67 卡片 meta 标签三元链(`activeKind === "anime" ? "动漫" : …`)——variety feed 卡片会错标「剧集」,加第 4 分支(与 D 档联动) |
| `apps/web/app/show/[tmdbId]/page.tsx` | :110 typeHint 白名单收 variety(详情页正确渲染) |
| `apps/web/lib/activity-season-label.ts` | **零改动**:唯一类型判断 :36 是 `type === "movie"` 排除式,variety 天然输出「第 N 季」 |

A 档效果:新入库综艺上「综艺」架、显示「综艺」,但**仍落 TV 目录、走 tv 配方**——
零行为变更,纯分架。搜索候选卡片(page.tsx:320 / search-view)维持「剧集」标签不动
(那里是 TMDB 上游 base type,分类发生在其下游)。

### C 档 · 独立网盘落点「Variety」(首批实施,P1,≈ 1–1.5 人日)

```
Mediary Scout/
├── Movies/  ├── TV/  ├── Anime/  └── Variety/   ← 新增
```

- **先决:引入幂等 ALTER 机制**。现库 SQLite 侧**零 ALTER 先例**(schema 一次性 final shape),
  `connected_storages` 加 `variety_cid` 列必须补一个 `ensureColumn`(PRAGMA table_info +
  ADD COLUMN,~15 行,放 sqlite.ts 建库路径)—— 一次投入,以后所有加列复用。
  (不推荐把 varietyCid 塞 `payload`:那是凭据列,语义混浊且 SELECT 点一个不少。)
- 克隆 anime 的既有通路(全部机械):
  - `account-credentials.ts`:`ProvisionedCids.varietyCid`、`provisionCategoryDirs` +
    `varietyName`(默认 `"Variety"`,env 可定制成 `综艺`)、legacy 迁移 seed null;
  - `sqlite.ts`:CREATE + ALTER 链 + 3 处带列清单 SELECT(:1284/:1350/:1382)+ 1 处行映射(:1273)
    + 2 处 INSERT/UPDATE;
  - `apps/web/lib/workflow-runtime.ts`:**新 env `MEDIA_TRACK_LIBRARY_VARIETY_DIR`**
    (定制目录名,缺省 `Variety`,与 `MEDIA_TRACK_LIBRARY_ANIME_DIR` 同级,读取点 :277-284)、
    parents.variety、`provisioned` 判断(:2278)、creds 自愈条件(:1675)、scopeCids(:1905)、
    resolveParent 链(:1990 `varietyCid || tvCid || env 缺省`)。
    ⚠️ 评审揪出的语义修正:varietyCid **纳入 provisioned/自愈** = 存量盘短暂转「待建树」,
    下一次队列/凭据解析会**在用户网盘真实新建 Variety 目录**(findOrCreate 闭包 :135-138,
    未命中即 :137 createDirectory 真实网络写);fallback TV 只覆盖建树失败路径。**拍板(§7.5):纳入**,
    与 anime 自愈语义一致;风险表述相应收窄为「**零采集风险**」。
  - `apps/web/lib/workflow-runtime.test.ts`:env 目录名定制用例(:447-459)补
    `MEDIA_TRACK_LIBRARY_VARIETY_DIR`(现有用例用「番剧」等中文定制值,综艺补「综艺」);
  - **env 触点范围(2026-09-26 已查)**:fpk 里只有 `MEDIA_TRACK_LIBRARY_ROOT_DIR` 进 cmd
    (build-fpk.sh:245/260 做 -dev 后缀 sed),MOVIES/TV/ANIME/VARIETY 均为纯运行时透传,
    **fpk/docker 零改动**;`docs/env-audit-report.html` 是带日期审计快照,不随更。
  - `consumption/context.ts`:`storageParentForTitle` +variety 分支;
  - `worker.ts`:`varietyStorageParentDirectoryId` 穿参 —— **6 处输入签名**(:87/:145/:298/:402/:445/:873)
    + **3 处 ConsumptionDeps 构造**(:346/:582/:772);`context.ts` 两接口两构造(:71/:98/:137/:169);
    apps/web 三处传 parents(`workflow-runtime.ts:718/:788/:1263`)。
    ⚠️ 触点分类(第 2 轮评审自纠后、作者再逐行复核):**:445 = runScheduledType3Monitoring(:435)
    是活的巡检签名**(apps/web :1263 的穿参接收方就是它)——**必须同步穿值,禁删**;
    :402/:873(runQueuedType2Workflow / runQueuedSeriesInitialization,经 :298/:407/:879 转发)
    才是「备料/兼容」保留口(注释实位于 `apps/web/lib/workflow-runtime.ts:779`,worker.ts:776-779
    是 movie 巡检直调代码);兼容口扩字段不传值 = 静默死字段,**同步穿值或一并删口,禁止半改**;
    movie 口 :847 无 anime 签名,不涉及。
  - 测试面:**4 个品牌级 connect 测试**(quark/guangya/tianyi/pan123)补 varietyCid;115 是 route 级
    mock(`app/api/115/qrcode/confirm/route.test.ts`)无 cid 可补;`tests/repository-contract.ts` 的
    drive() 当前不传 cid,**无需动**(前稿「补齐参数」系伪前提)。

### B 档 · 专属搜索配方 —— 暂缓(已拍板 §7.3,不进首批)

`search-profile.ts` + `cn-variety` / `generic-variety` + `PROFILE_RECIPES` 文案。
**动机存疑**:现有综艺就是 cn-tv 配方在线上采成功的(花少 S8/地球超新鲜),
先观察 variety 架跑一段再决定要不要专属配方;配方若做,须实测「更新至第N期/上中下打包」
的召回词形。**没有实证数据前不动 budgets/评分。**

### D 档 · 热门综艺 feed(首批实施,P1,≈ 0.5–1 人日 + proxy 重新部署)

- `apps/web/lib/trending.ts`:`TRENDING_KINDS.variety = discover/tv?with_genres=10764` +
  `with_original_language=zh` + `last_air_date.gte=<滚动半年>` + `sort_by=popularity.desc`
  (**不带 vote_count 门槛**,见 §1.4)。
- `workers/tmdb-proxy/src/handler.ts`:`getTrendingFeeds` 加同参数集 + rolling floor
  —— 两边「参数集相等」是缓存命中契约(anime 先例,注释写明 MUST match)。
- ⚠️ `apps/web/app/page.tsx:83-84`:`?trending=` 参数三元链对未知值**静默兜底 "movie"**——
  改成按 `TRENDING_KINDS` 键集合校验,否则第 4 个 feed 前端根本不可达(编译不报)。
- 前端第 4 入口 = TrendingRow 的 filter-pill(trending-row.tsx:33-43,`TRENDING_KIND_ORDER.map`
  起 :35、href 拼 `?trending=` 在 :39),由 `TRENDING_KIND_ORDER`(trending.ts:42)自动驱动,
  **不是 CategoryRow**(那是媒体库书架组件,page.tsx:514);:67 卡片 meta 标签同文件加第 4 分支
  (§4A 已列);`trending.test.ts` / `handler.test.ts` 双侧钉参数集(anime 先例 :299-311 同款)。
- 部署:worker 要 `wrangler deploy`(wrangler.jsonc 的 workers_dev 教训注释先读)。

### E 档 · 明确不做

存量改判/网盘搬迁;综艺独立 kind/管线;综艺专属命名规范(沿用 `Title.SxxExx`,锚定已保证);
字幕(总开关关闭中);type1(与本特性无关)。

## 5. 风险清单

| 风险 | 缓解 |
|---|---|
| 「else 兜底 / 运行时白名单」静默点(**编译都不报**):page.tsx:456 typeLabel、:444-448 分类过滤链、:83-84 trending 参数、demo-session.ts:45/:172 sessionStorage 白名单 | 全部改 `Record<MediaType,…>` / 键集合校验穷举;§4A 清单已逐点列名(评审第 1/2/9/10 条) |
| connected_storages 无迁移机制,老库缺列 crash | C 档先落 ensureColumn(幂等,try/catch duplicate);A 档不碰列 |
| 存量综艺巡检重复转存 | 铁律 2/3:不回填;`storageParentForTitle` 只认 title.type,存量 tv 不受影响 |
| 判据噪声(欧美真人实况、童装节目带 10764) | 观察期后可升 10764∧type=Reality AND 判据(§3 预留) |
| trending 契约两侧参数集漂移 → KV 永不命中 | 照抄 anime 的双边注释 + `handler.test.ts` 断言两边 feed 字符串一致 |
| NAS 全量构建 | 验证只用:`npx vitest run <单文件>` ×3–5 + 根 `npx tsc --noEmit`(CI 口径含 tests) |

## 6. 验收

- A:`media-classification.test.ts` 新用例绿;`variety-episode-landing.test.ts`、
  `fast-path.test.ts`、`v2-series-queue.test.ts` 原样绿(**反证管线未被动**);根 tsc 绿;
  `demo-session.test.ts` 硬计数更新绿(`demo-workflow.test.ts` 系 :24 下界断言,预期不红,
  跑一遍确认)。人检:`?type=variety` 分类页**只含综艺**、
  `?trending=variety` 第 4 pill 可切换、demo 模式综艺条目可见(运行时白名单已改的活证据)。
- C:account-credentials 建树测试 + 实测:连一个新账号看 Variety 目录建出、
  新导一档综艺(如「密室大逃脱」)type2 初始落 Variety;老 tracked tv 巡检无重复转存。
- D:本地 `curl tmdb-proxy.mediaryscout.app/discover/tv?with_genres=10764…` 有结果,
  部署后页面 feed 命中 KV(proxy 日志无 miss)。

## 7. 拍板记录(2026-09-26 用户确认)

1. **10767 脱口秀不并入** —— 唯一判据 `10764 真人秀`;欧美夜谈留剧集架。
   观察期后若判据有噪声/缺口,再评估 AND 判据(§3 的 type=Reality 预留)。
2. **C 档做**,环境变量必须显式注册:`MEDIA_TRACK_LIBRARY_VARIETY_DIR`
   (缺省 `Variety`,与 ANIME 同级;触点清单见 §4 C 档)。
3. **D 档进首批;B 档暂缓** —— 现有综艺就是 cn-tv 配方线上采成功(花少 S8/地球超新鲜
   实测 run),等综艺架跑一段攒了实证再另立。
4. **demo/fake 加综艺演示条目** —— 建议取「第N期上/下」形态(顺带在 demo 里展示 Part 锚定)。
5. (评审补记,2026-09-26)**varietyCid 纳入 provisioned/creds 自愈判断** —— 存量盘按 anime 同款
   语义自愈新建 Variety 目录(真实网络写,已知情);采集侧无重复转存风险(存量 tv 落点不动)。

## 8. 工时汇总

| 档 | 内容 | 估时 | 首批 |
|---|---|---|---|
| A | 判据 + 分架 + 标签穷举化 + demo 条目 + 测试 | 0.5–1 d | ✅ |
| C | ensureColumn + Variety 建树 + env + 穿参 + 测试 | 1–1.5 d | ✅ |
| D | trending 双侧契约 + proxy 部署 | 0.5–1 d | ✅ |
| B | PanSou 实证 + 配方 + 测试(暂缓,另立) | 1–2 d | ⏸ |
| **首批 A+C+D** | 分架 + 独立目录 + 热门 feed,零管线改动 | **≈ 2.5–3 d** | |
