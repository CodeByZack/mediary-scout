# 规范视频改名 — 具体实现方案（方案 A：staging 规范化，新增 renameVideo）

> 范围：**回填不做**。只做新入库规范视频改名。
> 流程：`inspectStaging → renameVideo → renameSubtitle → moveToSeason`（TV/动漫）；电影走 `flattenMovie` 自动改名（orchestrator 传 year）。
> 命名规则：电视/动漫 `Title.S01E01.ext`；电影 `Title (Year).ext`。第一版不加剧集标题（EpisodeName）。
> 分支：`feat/canonical-video-rename`（当前 HEAD == main，零提交；`canonicalEpisodeFileName` 已定义但零引用）。

---

## 1. renameVideo 工具接口设计

### 1.1 参数（batch shape，与 renameSubtitle 完全对称）

```ts
// sandbox.ts
async renameVideo(input: {
  renames: Array<{ fileId: string; newName: string }>;
}): Promise<{ renamed: string[]; errors?: Array<{ fileId: string; error: string }> }>
```

- **batch 一次调用**：agent 先 `inspectStaging` 拿全部 fileId，决定每一对的 newName，一次性提交（压测教训：77 集逐文件调用会崩塌，见 renameSubtitle 注释 `sandbox.ts:985`）。
- **整批只 listTree 一次**：staging 树一次快照服务整批，逐项校验引用同一快照，不逐文件烧 115 API（同 renameSubtitle 的 listTreeCalls===1 测试）。
- **逐项收集错误，不 abort 整批**：`errors: [{fileId, error}]` 返回违规项，其余照常执行。

### 1.2 返回

```ts
{ renamed: string[], errors?: Array<{ fileId: string; error: string }> }
```
与 renameSubtitle 一致：成功名单 + 逐项错误。空批 `renames: []` 直接 throw（`SANDBOX_EMPTY_RENAMES`，必须至少一项）。

### 1.3 输入校验规则（逐项，按顺序）

| # | 校验 | 失败 sentinel |
|---|---|---|
| 1 | `fileId` 必须在本任务 staging 树内 | `SANDBOX_FILE_NOT_IN_STAGING` |
| 2 | 源文件必须是视频（`target.isVideo`） | `SANDBOX_NOT_A_VIDEO: only videos may be renamed` |
| 3 | `newName` 必须是裸文件名，无 `/\//` 路径分隔符 | `SANDBOX_INVALID_VIDEO_NAME` |
| 4 | `newName` 必须保留视频扩展名（`/\.(mkv|mp4|avi|ts|m2ts|mov|flv|wmv)$/i`，与 simulator `VIDEO_EXTENSIONS` 对齐） | `SANDBOX_INVALID_VIDEO_NAME: must keep a video extension` |
| 5 | **TV/动漫**：`episodeCodeFromFileName(newName) !== null`（必须携带可解析的 `SxxExx`）——保证改名后文件在剧集身份契约下仍"可见"（`episode-code.ts:1-7` 的注释契约） | `SANDBOX_INVALID_VIDEO_NAME: newName must carry the episode code (SxxExx)` |
| 6 | **电影**：`newName` 必须匹配 `Title (YYYY).ext` 形状（含 `\(\d{4}\)`；若 sandbox 拿到 `canonicalYear` 则年份必须精确相等） | `SANDBOX_INVALID_VIDEO_NAME: movie name must be "Title (Year).ext"` |
| 7 | `newName` 不得含文件名非法字符 `[\\/:*?"<>|]`（title 清洗的一部分） | `SANDBOX_INVALID_VIDEO_NAME` |

**校验不做的事（明确不拦）**：
- 不要求 newName 前缀 == 标题。原因：真实包用场景名/罗马音/原名（如中文标题 `庆余年` + 文件 `Qing.Yu.Nian.S01E01.mkv`），Jellyfin/Plex 靠**目录名**匹配剧集、文件只要有 SxxExx 即刮削，前缀不必等于标题；硬校验会误杀合法改名。
- 不要求 newName 解析出的 code == 源文件名解析出的 code。原因：`第3集.mkv` 在 `Season 03` 里 `episodeCodeFromFileName` 只能读出 S01E03（`episode-code.ts:19`），而规范名必须是 S03E03——season 上下文只有 agent 知道，系统不能拿错误的 S01 去卡 S03。

### 1.4 系统生成 newName 还是 agent 自定？——**agent 自定 + 系统机械校验形状**

决定：**系统不生成 newName，agent 提交，系统只做 §1.3 的形状校验**。理由：
1. season 上下文（`第N集` 在非 S01 季 → SxxExx 的正确前缀）只有 agent 从 `inspectTargetDir` 看到季号后才知道；
2. title 前缀的拼写（中文/罗马音/原名）无法机械决定；
3. 与 renameSubtitle 的"agent 决定配对、系统校验"哲学一致，工具语义统一。

系统生成的方案（A2）留作后续增强：若未来发现 agent 频繁改错形状，可加 `renameVideo` 的 `preview` 模式或让 `inspectStaging` 直接展示建议名（`canonicalEpisodeFileName` 已具备生成能力）。

### 1.5 改名顺序与字幕的关系

- **顺序约束（硬）**：`renameVideo` 必须先于 `renameSubtitle`——字幕的 newName 前缀必须跟随视频的规范名（`Show.S01E01.mkv` → `Show.S01E01.ass`）。
- **v1 不做跨工具机械状态**：不维护"已改名视频名单"，顺序靠 skill + 工具描述强约束（见 §3/§4）。理由：给 renameSubtitle 加"前缀必须命中 staging 内某视频"的硬校验会破坏 2 个现有测试（`v2-sandbox-subtitle.test.ts` 中 renameSubtitle 测试的 staging 里没有视频），且把 blast radius 从 6 个文件扩到 8+。**记为 v1.1 增强**：在 renameSubtitle 里加 soft notice（前缀未命中任何 staging 视频 → 返回 `notices`，不 abort），或硬校验并同步更新测试。
- 字幕 .sc/.tc 简繁 infix 保留规则不变（`Show.S01E01.sc.ass`）。
- VobSub 对 `.sub+.idx` 两条都要改（renameSubtitle 已有 `SUBTITLE_NAME_PATTERN` 覆盖）。

---

## 2. canonicalEpisodeFileName 是否需要调整

**结论：函数本体不动，新增 2 个纯函数 + 明确契约注释。**

现状 `episode-code.ts:27`：
```ts
export function canonicalEpisodeFileName(input: { title; episodeCode; sourceName }): string
// → `${title}.${episodeCode}${extension}`
```

1. **season 上下文**：不改 `episodeCodeFromFileName`（改签名会波及 5 个 executor + fakes，风险大且没必要——agent 提交的 newName 已带正确 code）。给 `canonicalEpisodeFileName` 补注释：`episodeCode` 入参必须是**最终** code（含 season 修正后的，如 S03E03），不是源文件名解析出来的 S01E03。
2. **新增 `canonicalMovieFileName`**（电影路径 + flattenMovie 自动改名用）：
   ```ts
   export function canonicalMovieFileName(input: {
     title: string; year: number | string; sourceName: string;
   }): string {
     const extensionMatch = /\.[A-Za-z0-9]+$/.exec(input.sourceName);
     const extension = extensionMatch?.[0] ?? "";
     return `${input.title} (${input.year})${extension}`;
   }
   ```
3. **title 清洗防误解析 SxxExx**：新增 `cleanTitleForCanonicalName(title)`——去掉标题里 `SxxExx`/`第N集` 形状的子串 + 文件名非法字符（`[\\/:*?"<>|]`）。风险点（影响评估 §6a）：若标题本身含 `S01E01` 形状子串，规范名会被 `episodeCodeFromFileName` 误扫。**第一版在工具校验里只拦非法字符**（§1.3 #7），清洗函数作为纯函数提供 + 测试覆盖，供 skill 示例与未来系统生成模式使用；renameVideo 校验仍用 §1.3 #5（只要 ≥1 个可解析 code 即可，误扫风险低）。
4. **扩展名校验对齐**：`canonicalEpisodeFileName` 取 `/\.[A-Za-z0-9]+$/` 的扩展名——renameVideo 校验用 `VIDEO_NAME_PATTERN`（§1.3 #4）保证改名后仍是视频，二者不冲突。

---

## 3. 逐文件改动清单

### 3.1 `packages/workflow/src/episode-code.ts`
- 新增 `canonicalMovieFileName`、`cleanTitleForCanonicalName`（见 §2）。
- `canonicalEpisodeFileName` / `episodeCodeFromFileName` 本体不动，补 season 契约注释。
- 从 `index.ts` 的 `export *` 自动导出（`index.ts:11`），无需改 index。

### 3.2 `packages/workflow/src/acquisition-v2/sandbox.ts`
- 新增常量 `const VIDEO_NAME_PATTERN = /\.(mkv|mp4|avi|ts|m2ts|mov|flv|wmv)$/i;`（放 `SUBTITLE_NAME_PATTERN` 旁）。
- `TaskSandboxOptions` 新增可选字段：
  ```ts
  /** 规范改名上下文：TV/动漫标题（供 skill 提示/flattenMovie 电影名）；电影带 year。 */
  canonicalTitle?: string;
  /** 电影规范名 `Title (Year).ext` 的年份（仅电影传）。 */
  canonicalYear?: number;
  ```
- 构造函数存 `this.canonicalTitle / this.canonicalYear`（沿用 `titleTerms` 的传参模式）。
- 新增 `renameVideo`（§1.1-1.3，实现镜像 `renameSubtitle` 的批处理循环，`sandbox.ts:991-1036` 是模板）：
  ```ts
  async renameVideo(input: {
    renames: Array<{ fileId: string; newName: string }>;
  }): Promise<{ renamed: string[]; errors?: Array<{ fileId: string; error: string }> }> {
    // 1) storage/staging 句柄存在性
    // 2) renames 非空 → SANDBOX_EMPTY_RENAMES
    // 3) 一次 listTree 拿 staging 树
    // 4) 逐项：find(fileId) → isVideo 校验 → newName 形状校验（§1.3 #3-#7）
    //    TV: episodeCodeFromFileName(newName) === null → SANDBOX_INVALID_VIDEO_NAME
    //    movie: !/\(\d{4}\)\./.test(newName) 或 canonicalYear 不匹配 → SANDBOX_INVALID_VIDEO_NAME
    // 5) storage.renameFile({ directoryId: stagingDirectoryId, fileId, newName })
    // 6) renamed.push(newName)；catch → errors.push({fileId, error})
  }
  ```
- 电影：`flattenMovie`（`sandbox.ts:694`）内嵌自动改名——提升每个视频时若 `canonicalTitle` 存在：
  - 视频 → `canonicalMovieFileName({ title, year, sourceName })`；
  - 字幕 → `${title} (${year})${ext}`（.sc/.tc infix 保留规则同 renameSubtitle）；
  - 无 `canonicalTitle`（老测试构造的 sandbox）→ 行为不变（零破坏）。

### 3.3 `packages/workflow/src/acquisition-v2/agent-loop.ts`
- `buildSandboxToolSet` 无条件注册 `renameVideo`（TV 与电影都注册——电影侧 skill 引导用 flattenMovie，但工具存在不伤害；或按 `movie` 标志区分描述）。**推荐无条件注册**，描述里区分两种形状：
  ```ts
  tools["renameVideo"] = {
    description:
      "Rename landed video files to CANONICAL names BEFORE moving them, in ONE BATCH: decide EVERY video's canonical name first (fileIds from inspectStaging), then submit them all as renames:[{fileId,newName},…]. TV/anime: Title.S01E01.ext — must carry the episode code (SxxExx), keep the video extension (video Show - 01.mkv → Show.S01E01.mkv). Movie: Title (Year).ext — keep the video extension, the year must match. This is the FIRST rename: rename the videos, THEN renameSubtitle so each subtitle's prefix matches its video, THEN moveToSeason/flattenMovie. NEVER rename one file per call; per-item guard violations come back in `errors` without aborting the rest.",
    inputSchema: z.object({ renames: z.array(z.object({ fileId: z.string(), newName: z.string() })).min(1) }),
    execute: (args: { renames: Array<{ fileId: string; newName: string }> }) =>
      asEvidence(() => sandbox.renameVideo(args)),
  };
  ```
- `renameSubtitle` 描述更新：删掉 "the ONLY files you may rename (the documented exception)"，改为 "subtitles are renamed AFTER their videos — newName prefix must match the video's canonical name (video renamed first via renameVideo)"。
- `flattenMovie` 描述更新：加 "renames the film + its subtitles to `Title (Year).ext`"。
- `moveToSeason` 描述（可选）加一句 "files should already carry their canonical names (renameVideo first)"。

### 3.4 `packages/workflow/src/acquisition-v2/activity.ts`
- `interpretTool` 加分支（放在 renameSubtitle 旁）：
  ```ts
  case "renameVideo": {
    const count = asArray(args.renames).length;
    return { activity: count > 1 ? `正在规范化 ${count} 个视频文件名…` : "正在规范化视频文件名…", phase: "organize" };
  }
  ```

### 3.5 `packages/workflow/src/acquisition-v2/skill.ts`
- TV 段落 + SUBTITLE 段落 + MOVIE 段落（具体文本见 §4）。
- 若新增段落不改变 `SKILL_SECTION_NAMES` 结构，则 `skillIndexForAgent` / readSkill 的 section 列表测试不受影响（建议不改 section 集合，只改现有段落文本，把改名写进现有 `tv` / `movie` / `subtitle` 段落）。

### 3.6 `packages/workflow/src/acquisition-v2/task-agents.ts`
- `SANDBOX_BOUNDARY`（`task-agents.ts:42-45`）重写"不改名"句（见 §4）。
- `LOOP_GUIDANCE` 步骤 3/4 之间插入：先 `renameVideo` 规范化、再 `renameSubtitle` 配对、再 `moveToSeason`。
- `buildMovieSystemPrompt` 步骤 5（flattenMovie）：加"flattenMovie 会把电影与字幕自动改成 `Title (Year).ext`"。
- `subtitleSnapshotPointer` 无需改（已说 renameSubtitle to match the video）。

### 3.7 `packages/workflow/src/acquisition-v2/agent-loop-guards.ts`
- `STEP_50_REMINDER`（`agent-loop-guards.ts:21-27`）② 步改为：
  "把已转存好的先规范化文件名（TV/动漫 renameVideo 得 Title.SxxExx、renameSubtitle 配对字幕；电影 flattenMovie 自动改名入影片目录），再 moveToSeason 入季 / markObtained 确实落盘的;"
- `BUDGET_REMINDER`（`agent-loop-guards.ts:48-54`）② 步同步。

### 3.8 `packages/workflow/src/acquisition-v2/orchestrator.ts`（电影路径传 year）
- 构造 `TaskSandboxOptions` 时追加：
  ```ts
  canonicalTitle: request.target.title,
  ...(request.target.kind === "movie" ? { canonicalYear: request.target.year } : {}),
  ```
- `runAcquisitionV2Request` 无需新字段（`target` 已有 `title`/`year`）。
- 电影调用链：`movie-workflow-v2.ts:82-91` 已传 `target: { kind:"movie", title, year, ... }` → orchestrator 取到 `request.target.year`，无需改 movie-workflow-v2.ts。

---

## 4. skill.ts 文本改动草案

### 4.1 TV 段落（`skill.ts:236` "Messy real packs (lived)"）

原文（节选）：
> ...You map each to its episode by READING the name ("第3集"=E03, "尝鲜版09"=E09, an "End"/"完" marker = the finale) — no regex, no parser. **Keep the ORIGINAL names (never rename).** ...

改为：
> ...You map each to its episode by READING the name ("第3集"=E03, "尝鲜版09"=E09, an "End"/"完" marker = the finale) — no regex, no parser. **Then RENAME every landed video to the canonical form BEFORE moving it: `Title.SxxExx.ext`** (视频扩展名不变;`第3集` 落在 `Season 03` 就改 `Title.S03E03.ext` —— season 由你从 inspectTargetDir 看到的季号决定,不是文件名里的 S01)。改名是 staging 规范化的核心一步:改名后文件在季目录里对刮削器一目了然,下次巡检补缺也一眼可认。当两个文件覆盖同一集时,先按大小去重保留大文件,再对保留的那个改规范名(避免先改名撞出 `(1)` 后缀)。

### 4.2 新增 TV 改名顺序块（放 TV 段落 "Batch distribution" 前）

> ## Canonical naming — rename BEFORE you distribute (hard order)
> After `inspectStaging` classifies the files, and BEFORE `moveToSeason`, normalize every video you intend to keep:
> 1. `renameVideo({ renames:[{fileId,newName},…] })` — ONE BATCH call for ALL videos. TV/anime: `Title.SxxExx.ext` (video 扩展名不变;必须带集号;season 以目标季为准)。
> 2. `renameSubtitle({ renames:[{fileId,newName},…] })` — AFTER the videos, so each subtitle's prefix matches its video (`Title.S01E01.mkv` → `Title.S01E01.ass`;简/繁保留 `.sc/.tc`;VobSub 的 `.sub+.idx` 都改)。
> 3. `moveToSeason` — the renamed video + its subtitles ride in the same season's fileIds.
> Order is HARD: rename the video first, then the subtitle. A subtitle renamed before its video pairs against the wrong prefix. 每批一次调用,不要逐文件改(77 集教训)。

### 4.3 SUBTITLE 段落（`skill.ts:263-266`）

第 3 步原文：
> 3. `renameSubtitle({ renames: [{fileId, newName}, …] })` — ... Subtitles are the **ONLY** files you may rename — the documented exception — so the player auto-loads them. ...

改为：
> 3. `renameSubtitle({ renames: [{fileId, newName}, …] })` — ONE BATCH call for ALL landed subtitles: decide every subtitle↔episode pairing (fileIds from inspectStaging), then submit them together. **Call this AFTER `renameVideo`** — each newName = the matching video's canonical prefix + the subtitle extension (`Title.S01E01.mkv` → `Title.S01E01.ass`;简/繁 double subs keep their `.sc/.tc` infix). Subtitles are renamed to match their videos (the scraper auto-loads them) — the video rename comes FIRST so the prefix is canonical. NEVER rename one file per call ... (其余保留)。

### 4.4 MOVIE 段落（`skill.ts:184` 附近 + flattenMovie）

原文：
> ...You do NOT moveToSeason and you do NOT discardStaging for a movie: the film lands in the movie directory and flattenMovie cleans its wrapper IN PLACE...

追加（或改 flattenMovie 描述处）：
> The film and its subtitles are renamed AUTOMATICALLY by flattenMovie to the canonical form **`Title (Year).ext`** (e.g. `奥本海默 (2023).mkv` + `奥本海默 (2023).ass`) — you do NOT call renameVideo for a movie; flattenMovie handles it in place. 无需手动改名;若 flattenMovie 后你发现名字仍不规范,说明该任务缺标题上下文,照常继续即可(刮削以目录名为准)。

### 4.5 task-agents.ts `SANDBOX_BOUNDARY`（`task-agents.ts:42-45`）

原文：
> Files keep their ORIGINAL names. Do not rename anything. Identity is YOUR judgment from the real files...

改为：
> Videos are renamed to CANONICAL names before they move: TV/anime `Title.S01E01.ext`, movie `Title (Year).ext` (via renameVideo / flattenMovie — the ONLY renaming the sandbox permits, and only for files in staging). Subtitles are renamed to match their videos AFTER the video rename. Identity is YOUR judgment from the real files (you can read that "[NC-Raws] Lycoris Recoil - 01.mkv" is S01E01) — the rename just makes that judgment visible in the filename; there is no fileId↔episode map to maintain.

---

## 5. 测试计划

### 5.1 新增测试

| 文件 | 用例 |
|---|---|
| `tests/episode-code.test.ts` | `canonicalEpisodeFileName`（含扩展名透传）;`canonicalMovieFileName`（`Title (Year).ext`、缺年份兜底）;`cleanTitleForCanonicalName`（剥 SxxExx/第N集 形状子串 + 非法字符） |
| `tests/v2-sandbox-rename-video.test.ts`（新建，镜像 `v2-sandbox-subtitle.test.ts`） | ① 批处理 happy path（staging 2 视频一次改名成功、errors 缺省）② fileId 不在 staging → SANDBOX_FILE_NOT_IN_STAGING ③ 源不是视频（字幕）→ SANDBOX_NOT_A_VIDEO ④ newName 含路径分隔符 ⑤ newName 丢视频扩展名 ⑥ TV newName 无 SxxExx（如 `Show.mkv`）→ SANDBOX_INVALID_VIDEO_NAME ⑦ 电影形状 `Title (Year).ext` 校验（有/无 canonicalYear）⑧ 空批 throw ⑨ 整批一次 listTree（listTreeCalls===1）⑩ 改名后 `episodeCodeFromFileName` 能回解出 code（一致性） |
| `tests/v2-sandbox-move.test.ts` 或新建 flatten 用例 | `flattenMovie` 在 `canonicalTitle+canonicalYear` 存在时把视频+字幕改成 `Title (Year).ext`;未传时行为不变（零破坏回归） |
| `tests/v2-agent-loop-tools.test.ts` | renameVideo 在默认/`movie:true` toolset 都注册;描述含 TV/电影两种形状 |
| `tests/activity.test.ts` | `renameVideo` → "正在规范化视频文件名…" / "正在规范化 N 个视频文件名…"（organize） |
| `tests/v2-task-agents.test.ts` | 新 invariant：prompt 含 `renameVideo`、`Title.S01E01.ext` / `Title (Year).ext`、顺序词（rename 先于 move） |
| `tests/v2-skill.test.ts` / `tests/skill-subtitle.test.ts` | tv 段落含规范名指令;subtitle 段落含 "AFTER / 先改视频" 顺序;movie 段落含 flattenMovie 自动改名 |

### 5.2 现有测试会挂、需更新

| 文件 | 挂点 | 更新 |
|---|---|---|
| `tests/v2-agent-loop-tools.test.ts:30-47` | "exposes exactly the sandbox tools" 断言**精确工具列表** | 列表加 `"renameVideo"` |
| `tests/v2-task-agents.test.ts:66` | `/do not rename\|never rename\|keep.*original name/i, "no renaming"`——TV prompt 不再含"不改名"字样 | invariant 改为"canonical rename"（如 `/renameVideo|Title\.S\d{2}E\d{2}|canonical/`） |

**不会挂（已核实）**：
- `v2-sandbox-subtitle.test.ts`（renameSubtitle 仍拒绝视频 → "videos stay un-renameable" 测试继续成立，因为 renameVideo 是**新工具**，不放松 renameSubtitle）；
- `skill-subtitle.test.ts`（`/rename|重命名/` 仍匹配）；
- `v2-skill.test.ts`（无"never rename"断言；section 集合不变）；
- acceptance / move / multiseason / coverage 测试（直接调 sandbox API，不经过 agent 工具注册表；flattenMovie 未传 title/year 时行为不变）；
- `commands.test.ts`（手动导入路径不改，`importForeignWorkAsMovie` 保持原样——它不属于 acquisition 流程）。

---

## 6. 实施顺序

> 验证命令：`npm run typecheck`（tsc --noEmit）、`npx vitest run <file>`（定向）、`npm test`（全量，vitest run）、`npm run lint`。

| 步骤 | 内容 | 验证 |
|---|---|---|
| **1** | `episode-code.ts`：新增 `canonicalMovieFileName` / `cleanTitleForCanonicalName` + 契约注释；`episode-code.test.ts` 补用例 | typecheck + episode-code 定向测试 |
| **2** | `sandbox.ts`：`VIDEO_NAME_PATTERN`、`TaskSandboxOptions.canonicalTitle/canonicalYear`、`renameVideo` 实现；新建 `v2-sandbox-rename-video.test.ts` | typecheck + 新测试全绿（含 listTree 一次、逐项错误） |
| **3** | `agent-loop.ts` 注册 renameVideo + 更新 renameSubtitle/flattenMovie 描述;`activity.ts` 加分支;`v2-agent-loop-tools.test.ts` 更新工具列表 + `activity.test.ts` 补用例 | typecheck + 两文件定向测试 |
| **4** | 提示词：`task-agents.ts`（SANDBOX_BOUNDARY + LOOP_GUIDANCE + movie 步骤）、`skill.ts`（§4 全部草案）、`agent-loop-guards.ts`（两个 reminder）;更新 `v2-task-agents.test.ts:66` + 新增 prompt invariant 用例 + `v2-skill.test.ts`/`skill-subtitle.test.ts` 补充断言 | typecheck + 相关定向测试 |
| **5** | 电影路径：`orchestrator.ts` 传 `canonicalTitle/canonicalYear`;`sandbox.flattenMovie` 内嵌自动改名 + 测试（含未传上下文零破坏回归）;`v2-movie-workflow` 相关 e2e 走一遍 | typecheck + 定向测试 + `npm test` 全量 |
| **6** | 全量回归：`npm test` + `npm run lint`;手工 e2e（MEDIA_TRACK_AGENT_LOG=1 跑一个 TV 任务,确认流程 inspectStaging → renameVideo → renameSubtitle → moveToSeason 走通） | 全量测试 + lint + 一次 live e2e |

**风险清单（实施时盯）**：
- 工具列表精确断言（步骤 3 是唯一"机械挂点"）。
- prompt 文本断言（步骤 4 两个正则）。
- flattenMovie 自动改名只应在传了 `canonicalTitle` 时生效（老测试零破坏）。
- 顺序约束 v1 靠提示词,不做机械状态（v1.1 再加 renameSubtitle 前缀 soft notice）。
