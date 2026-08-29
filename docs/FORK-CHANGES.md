# FORK-CHANGES — 项目变更记录（fork 起步 → 独立维护）

> 记录自 fork 上游 `fancydirty/mediary-scout`（main）以来的全部改动。
> **2026-08-29 起本仓库独立维护（§25），不再计划与上游同步；本文件即项目的完整开发史。**
> 维护方式：每次改动后在此追加条目；与 TODO 文档不同，这是长期保留的变更日志。

## 改动一览

| 日期 | 类型 | 内容 |
|------|------|------|
| 2026-08-10 | feat | 规范视频改名（staging 规范化，renameVideo） |
| 2026-08-10 | fix | fake drive 默认转存结果 + 存储品牌回退 |
| 2026-08-11 | feat | 通知页与活动页展开步骤 + 步骤细节丰富 |
| 2026-08-11 | feat | 飞牛 fnOS fpk 打包方案（deploy/fpk/） |
| 2026-08-11 | fix | 应用图标四角白边清理 |
| 2026-08-11 | chore | 清理功能 TODO 文档，收拢为本变更日志 |
| 2026-08-11 | fix | Server Actions CSRF 修复（反代下被 Next 16 拦截，PR #2） |
| 2026-08-11 | feat | 双架构 fpk 打包 workflow（arm64 + x64，PR #3） |
| 2026-08-12 | chore | 完全移除 Mediary Connect 远程访问功能及全部残留 |
| 2026-08-12 | fix | 统一 fpk 双架构命名为 arm/x86 + 修复 Install fnpack 步骤 exit 127 |
| 2026-08-12 | fix | fpk 打包清理 sharp musl 变体，产物 22M → 15M |
| 2026-08-12 | fix | fpk cmd/wizard 脚本加可执行位，修复 fnOS 安装报"无法设置目录权限" |
| 2026-08-12 | feat | fpk 打包支持测试版（FPK_MODE=test / workflow mode 参数）：独立 appname/端口/数据目录，反复试装不影响正式版 |
| 2026-08-16前后 | feat | fpk fake 运行模式(PR #14)、PanSou 零结果兼容(#16) |
| 2026-08-18~19 | feat | **fast path 落地(PR #17)**:评分/摘要/集数解析/映射仲裁/finalize 全链路,TVMovie 双分支 |
| 2026-08-21 | fix | PR #18:单季任务按目标季解析集数(修 S03 纯数字假入库) |
| 2026-08-22 | fix | PR #19:finalizeLanding 透传目标 seasons + skipCodes(修整包候选重复归位) |
| 2026-08-29 | feat | **PR #20 任务消费流水线重构**(七步主干+可观测性+预算闸+UI 证据+别名简体化/合并证据池/简繁折叠,§19-23);v1.0.0 重发布 |
| 2026-08-29 | chore | 移除桌面版(Electron)与其发布流水线(§24) |
| 2026-08-29 | chore | **仓库精简与上游断开**(§25):死文件/死依赖/过时文档清理,README 双版重写,站内链接指向自有仓库 |

---

## 详细记录

### 1. 规范视频改名（canonical video rename）

**提交**: `3e64c28` — feat(workflow): canonical video rename on staging normalization

在 staging 规范化阶段，把待入库视频文件改成 TMDB 规范文件名再移入媒体库：
- TV：`Title.S01E01.ext`；电影：`Title (Year).ext`（经 flattenMovie）
- 新增 `renameVideo` / `moveToSeason` / `deleteFiles` 工具，接入 v2 sandbox orchestrator
- 字幕文件跟随视频前缀（`.sc` / `.tc`）
- 新增 `canonicalMovieFileName` / `cleanTitleForCanonicalName`（episode-code.ts）
- 提示词三件套（task-agents.ts / skill.ts / agent-loop-guards.ts）同步更新

涉及文件：`packages/workflow/src/episode-code.ts`、`acquisition-v2/sandbox.ts`、`agent-loop.ts`、`activity.ts`、`orchestrator.ts`、`skill.ts`、`task-agents.ts`、`agent-loop-guards.ts` + 新增 4 个测试文件。

### 2. fake drive 默认转存结果 + 存储品牌回退

**提交**: `1dc4644` — fix(workflow): fake drive default transfer outcome + storage brand fallback from env

- `FakeStorageExecutor` 的 `defaultTransferOutcome` 允许真实（pansou）候选在 fake 盘中落盘，从而无需真实 115/夸克 cookie 即可端到端预览改名流程；fake transfer id 限定在单 run 内，避免与全局 `transfer_attempts.id` 主键冲突
- `driveProvider` / `resource-provider` 回退时优先读 `MEDIA_TRACK_DEFAULT_STORAGE_BRAND` 环境变量，再默认 pan115（此前环境变量被忽略，未连接网盘的 dev/fake 部署会过滤掉全部夸克链接导致 0 候选）

### 3. 通知页与活动页展开步骤 + 步骤细节丰富

**提交**: `d8d1797` — feat(web): 通知页与活动页展开步骤 + 步骤细节丰富（搜索结果数/改名数等）

- 后端 `activity-view.ts`：新增 `ActivityStepStatus` / `ActivityStepView` 类型 + `steps` 字段，repository 加 `listAgentSteps`，per-run 查询 + 状态推断（成功/进行中/失败+原因），历史放开全量（limit 1000）
- 前端 `activity-feed.tsx`：每行点击展开显示完整步骤列表（图标/activity/toolName/时间/参数/failReason），保持轮询/进度逻辑
- 通知页重构（`NotificationCardWrapper.tsx` / `RoutineCardWrapper.tsx`），展示搜索结果数、改名数等细节
- `stub-model.ts` 大改：有状态单例跨 run 复用、move/flatten/discard 失败分支 reportNoCoverage、happy path 目录级断言、movie 路径用例、search 失败兜底等
- 新增 `preview-manager.sh`（本地 preview 起停脚本）

### 4. 飞牛 fnOS fpk 打包方案

**未提交**（工作区改动，`deploy/fpk/` 为新目录）

- 完整 fpk 骨架：`manifest` / `config/` / `cmd/main` / `app/ui/config` / `app/ui/images` / `wizard/` / 图标
- `deploy/fpk/build-fpk.sh`：一键构建（`npm run build:web` → standalone 三件套填充 → fnpack build），产物 `deploy/fpk/dist/mediary-scout.fpk`（15M）
- `deploy/fpk/README.md`：打包说明
- `.gitignore` 新增 `deploy/fpk/app/server/` 与 `deploy/fpk/dist/`（构建产物不入库）
- 已在本机验证两次构建成功、fnpack 校验通过；待真机冒烟测试（启动 server 需 kill 审批，未执行）

### 5. 应用图标四角白边清理

**未提交**（工作区改动）

- 源图标 `apps/desktop/build/icon.png`（1024）圆角弧线外残留白色背景，用 flood-fill 清掉 34816 个白色像素
- 从干净源图重新 LANCZOS 生成 64/256 各尺寸（`deploy/fpk/ICON.PNG`、`ICON_256.PNG`、`app/ui/images/icon_*.png`），并清掉缩放产生的低透明过渡像素
- 验证：所有图标四角全透明、白色像素 = 0

### 6. 清理功能 TODO 文档

- 删除根目录 9 个阶段性 TODO/PLAN 文档（ACTIVITY_* / CANONICAL_VIDEO_RENAME / FPK_* / IMPACT_VIDEO_RENAME / RENAMEVIDEO_PLAN / STUB_FIX / VIDEO_RENAME_IMPL_PLAN）
- 其中 `VIDEO_RENAME_IMPL_PLAN.md` 曾随 `3e64c28` 提交入库，本次用 `git rm` 移除
- 功能记录统一收拢到本文件（`docs/FORK-CHANGES.md`）

### 7. Server Actions CSRF 修复（PR #2）

**提交**: `869ca66` — fix(web): 修复反代下 Server Actions 被 Next 16 CSRF 校验拦截（合并 `f4720ee`）

- 通过反代/中继域名（如 `office.app.5ddd.com` 动态端口）访问时，所有 server action 请求（点"获取第几季"等）被 Next 16 丢弃（E80）：`x-forwarded-host`（内网 IP）与浏览器 `origin`（动态端口公网域名）不匹配
- `apps/web/proxy.ts`：对带 `Next-Action` header 的请求，若 `x-forwarded-host` 与 `new URL(origin).host` 不一致则改写为 origin host；其余请求原样放行，auth gate 零改动
- `proxy.test.ts` 新增 8 个用例；全量回归 3016 passed / 0 failed

### 8. 双架构 fpk 打包 workflow（PR #3）

**提交**: `7215199` — ci: 新增双架构 fpk 打包 workflow（arm64 + x64）；`0564de6` — fix(fpk): fnpack 产物按 appname 命名，mv 目标改为架构化文件名（合并 `c2e96e2`）

- 新增 `.github/workflows/build-fpk.yml`：matrix 双架构（arm64 → `ubuntu-24.04-arm`，x64 → `ubuntu-latest`），触发方式 = push tag `v*` 自动构建 + `workflow_dispatch`（可带 tag 输入发布 Release）
- Node 24（ABI 137）与飞牛 fpk manifest `install_dep_apps=nodejs_v24` 对齐，better-sqlite3 无需交叉编译；fnpack 1.2.1 官方二进制（amd64/arm64）sha256 固定校验
- `build-fpk.sh` 产物按架构化文件名输出；README 同步

### 9. 完全移除 Mediary Connect 远程访问功能（含残留清理）

**提交**: `6edecc0` — chore: 完全移除 Mediary Connect 远程访问功能；`3f93251` — chore: 清理 Mediary Connect 残留（文档/SEO/站点文案/死 CSS）

- 删除 `workers/scout-connect/` 控制面 Worker（117 文件，约 2.4 万行，Cloudflare Tunnel + D1 + Paddle 支付）
- 删除 apps/web 11 个 connect 文件（remote-access-section / connect-login-form / connect-notice-banner / remote-access*.ts / connect-notice*.ts / remote-access-test-button）
- 清理引用：page.tsx banner、settings RemoteAccessSection、globals.css `.connect-notice` 样式、docker-compose cloudflared 服务、.env.example TUNNEL_TOKEN、ci.yml 步骤
- 删除纯 Connect 文档（cf-tunnel 转售许可邮件、seo-interlink-findings），清理 SEO-STATE / site/index.html / sitemap.xml / style.css 死 CSS（60 行）
- **保留**：网盘绑定 connect*Action（connectQuark/GuangYa/TianyiSson）、Next `connection()` API、`.qr-connect` 样式
- 验证：apps/web typecheck EXIT 0；全仓库 grep 零残留

### 10. 统一 fpk 双架构命名为 arm/x86 + 修复 Install fnpack 步骤 exit 127

**提交**: `3e3d647` — fix(fpk): 统一架构命名 arm/x86，修复 Install fnpack 步骤 exit 127

- matrix 架构 key 与 artifact 统一为 `arm` / `x86`（此前 job 名显示 "Build fpk (arm64)/(x64)"、artifact 叫 fpk-arm64/fpk-x64）；runner（ubuntu-24.04-arm / ubuntu-latest）与 fnpack_arch（官方下载 URL 后缀 amd64/arm64）是外部命名，保留并在注释说明
- 修复 Install fnpack 步骤 exit 127：`echo "/tmp" >> GITHUB_PATH` 只对后续 step 生效，当前 step 内 PATH 未更新导致 `fnpack --help` command not found；改用完整路径 `/tmp/fnpack --help`，末行固定输出路径
- 注释与 `deploy/fpk/README.md` 措辞同步统一（arm 即 aarch64、x86 即 x86_64）
- 验证：YAML 解析 OK；`x64` 全文件零残留，`arm64` 仅剩 fnpack 官方 URL 后缀
- 补（PR #4 内）：`deploy/fpk/build-fpk.sh` 增加可执行位（100755），修复 CI checkout 后 `./build-fpk.sh` Permission denied（git 原记录为 100644）

### 11. fpk 打包清理 sharp musl 变体（产物 22M → 15M）

**提交**: `91c3279` — fix(fpk): 打包时清理 sharp musl 变体，减小 fpk 体积

- 根因：npm（11.8.0 实测）对 optionalDependencies 的 **libc 过滤失效**，`npm ci` 会把 sharp 的 glibc + musl 两种 libc 原生二进制都装进 `node_modules/@img/`（os/cpu 过滤正常，darwin/win32/wasm32 不会被装）；本地旧 node_modules（08-09 安装）恰好只有 glibc，故本地打包 15M、CI 打包 22M
- 修复：`build-fpk.sh` 填充 app/server 后、fnpack 打包前，删除 `@img/` 下所有 `*linuxmusl*` 变体（一个 glob 覆盖 sharp-libvips-linuxmusl-* 与 sharp-linuxmusl-*，arm/x86 通用）；`[ -d ]` 守卫 + `|| true` 兼容 set -euo pipefail，@img 不存在静默跳过；打印移除明细便于 CI 日志确认
- 验证：本地完整打包通过，产物 `mediary-scout-arm.fpk` 15M（CI 22M）；模拟 musl 目录删除路径实测生效、glibc 保留

### 12. fpk cmd/wizard 脚本加可执行位（修复 fnOS 安装报"无法设置目录权限"）

**提交**: `83e3a46` — fix(fpk): cmd/wizard 脚本加可执行位 (100755)

- 现象：CI 打的 fpk 在飞牛应用中心安装报"无法安装 无法设置目录权限"
- 根因：git 索引里 `deploy/fpk/cmd/*`（main/install_init/install_callback 等 9 个）与 `wizard/*`（install/uninstall）都是 100644 无执行位；本地工作区文件带 x（打包产物正常），CI checkout 后按 git mode 恢复为 644 → fnpack 打包后 fpk 内脚本无 x → fnOS 安装时无法执行安装回调脚本
- 修复：`git update-index --chmod=+x` 将 cmd/* 与 wizard/* 共 11 个脚本改为 100755（与 build-fpk.sh 同源问题，一并根治）
- 验证：git ls-files -s 确认全部 100755；需 CI 重新打包后真机安装验证
- 补（同 PR 内）：`build-fpk.sh` 新增 2.6 节，打包前强制 `chmod +x cmd/* wizard/*`，git mode 再丢失也能保证产物带执行位（防止同类问题第三次复发）

### 13. fpk 打包支持测试版（FPK_MODE=test / workflow mode 参数）

**提交**: （本次）`feat(fpk): 打包支持测试版 FPK_MODE=test`（build-fpk.sh + build-fpk.yml）

- 动机：正式版已装进飞牛，每次测试新包都要卸载重装、正式数据（@appdata/mediary-scout）被清掉
- `build-fpk.sh` 新增 `FPK_MODE` 环境变量（release 默认 | test）：
  - test 模式 = `appname=mediary-scout-dev`、`display_name=MediaTrack (测试版)`、`service_port=3334`、`desktop_applaunchname=mediary-scout-dev.Application` → 飞牛按 appname 分配完全独立的安装/数据/配置目录，装/卸都不碰正式版
  - 产物名 `mediary-scout-dev-<ARCH>.fpk`；每次打包全量写回 manifest 全部字段，避免 test/release 互相残留污染
  - `cmd/main` 零改动（TRIM_APPDEST/TRIM_PKGVAR 由飞牛按 appname 自动注入，日志/PID/数据库路径全自动分开）
- `build-fpk.yml` workflow_dispatch 新增 `mode` 下拉（release | test）：
  - test 时 artifact 名为 `fpk-arm-dev` / `fpk-x86-dev`，上传路径对应 dev 产物
  - release job 在 test 模式跳过（测试包不进正式 Release）
- 验证：bash -n 语法 OK；YAML 解析 OK；manifest sed 分支逻辑确认

---

## 任务消费流水线重构（consumption pipeline，纯等价重构）

> 设计蓝图：`/vol1/1000/docs/mediary-scout-consumption-refactor-design.md`（§2 七阶段主干 / §3 ConsumptionContext / §7 文件布局）。
> 目标：把「认领→落库」从 4 层参数透传（workflow-runtime → worker → runner-v2 → workflow-v2 → orchestrator）收敛为
> 一次性 `ConsumptionContext` + 七阶段 `consumeClaimedRun(ctx)`。**纯等价重构：外部行为、日志文案、通知口径、失败语义零变化。**
> 器件（TaskSandbox/candidate-grader/三仲裁/staging-digest/finalize-landing/subtitle-picker/episode-code/SQLite schema）一律不动。
> 与设计的 4 处已对齐偏差：A 认领循环留在 workflow 包（apps/web 只备料）；B movie「落点已有视频」检查留在 ④（前移会省一次真实搜索=行为变化）；
> C pipeline 不吞异常、调用方分派 failure 语义（队列 handleWorkflowRunFailure / 巡检自 catch）；D 过渡期三个 runQueued* 名字保留为表驱动薄包装。

### 14. 步骤①——consumption/context.ts + pipeline.ts 转发骨架，三个队列入口接线

**提交**: （本次）`refactor(consumption): 步骤① 消费上下文与七阶段纯转发骨架`

- 新增 `packages/workflow/src/consumption/context.ts`：ConsumptionContext（kind/title/claimed/patrol + 消费依赖 + 注入能力 + 运行上下文，design §3 分组）、ClaimedRun（保留完整 snapshot——type1 锁 run 收尾需 WorkflowRun 全展开，设计稿的扁平 episodes/titleRef 由此导出，有损重建被等价原则否决）、PatrolRun（步骤⑥巡检直调时启用）、`buildConsumptionContext`（resolveWorkerDeps 合并后的依赖一次性装袋；type1 的 seasonScopes 派生自 series_init_queued 审计事件）；`storageParentForTitle`/`requireCategoryParent` 自 worker.ts 逐字迁入（= ①目录阶段的父级选择 + fail-loud）
- 新增 `packages/workflow/src/consumption/pipeline.ts`：`consumeClaimedRun(ctx)` 七阶段主干入口（①prepareDirectories ②withStagingCleanup ③computeNeed ④runAcquisition ⑤reconcileNeed ⑥readLandedSize ⑦persistOutcome）。当前形态=按 kind 纯转发到现有 runner-v2 实现（其内部已按 ①–⑦ 顺序执行），步骤②–⑤ 逐阶段替换转发；type1 分支已吸收原 worker 尾段「claimed 锁 run 收尾落库」（逐字搬迁）；异常一律上抛由调用方分派（偏差 C），队列侧 catch 语义原封不动
- `worker.ts`：runQueuedType2Workflow / runQueuedSeriesInitialization / runQueuedMovieAcquisition 三个认领入口的 try 体 → buildConsumptionContext + consumeClaimedRun；认领、resolveWorkerDeps、catch/handleWorkflowRunFailure 原位不动；两个私有 helper 迁出、失效 import 清理；type3 巡检与 patrolMovie 暂不切（步骤⑥按决策 1 直调 pipeline）
- `index.ts`：新增 consumption 两模块出口
- 验证：`./node_modules/.bin/tsc -p tsconfig.workflow-check.json` exit 0；vitest 9 个链路测试文件（worker / type3-worker / handle-workflow-failure / run-retry-transitions / v2-series-queue / v2-full-chain / v2-runner-persist / cancel-queued / movie-command-worker）= 9 files / 50 tests 全绿

### 15. 步骤②——stages/directories.ts + stages/need.ts：①②③⑤⑥ 阶段收口

**提交**: （本次）`refactor(consumption): 步骤② 目录/清理/需求对账阶段收口 stages/*`

- 新增 `consumption/stages/directories.ts`：①`prepareDirectories`、②`withStagingCleanupStage`（335 文件泄漏兜底）、⑥`readLandedSizeStage`（best-effort 体积）——薄收口，器件 directory-lifecycle.ts / landed-size.ts 不动
- 新增 `consumption/stages/need.ts`：③`computeNeed` → `NeedSnapshot{missing,obtained,providerAhead}`、⑤`reconcileNeed`（prior ∪ agent 标记，不重扫网盘）、no-op 零 API 早退的产物形状 `noOpWorkflowStageResult`/`assembleNoOpWorkflowResult`（原 EMPTY_OUTCOME 收编）
- `acquisition-v2/workflow-v2.ts` 改调 stages 收口点（同一实现换门牌）：7a/7b 段与早退分支逐字等价；本地 EMPTY_OUTCOME 删除
- 行为零变化——只是把装配段升格为按七阶段命名的文件，调用链仍经 workflow-v2（type1/type3/movie 转发路径同样受益）
- 验证：tsc exit 0；vitest 11 文件 63 用例全绿（v2-workflow / v2-sync-need / v2-directory-lifecycle / v2-sandbox-cleanup / landed-size / staging-cleanup + 队列回归 worker / v2-full-chain / v2-series-queue / type3-worker）

### 16. 步骤③——stages/acquire.ts：④装配段收口（唯一烧配额阶段）

**提交**: （本次）`refactor(consumption): 步骤③ ④装配段收口 stages/acquire.ts`

- 新增 `consumption/stages/acquire.ts`：`runAcquisitionCoreStage` = 原 workflow-v2.ts 闭包里的 orchestrator 装配调用（spread 长链逐字搬迁）+ ⑤对账 + ⑥体积 + 结果组装，连段顺序即语义不变；`RunAcquisitionV2WorkflowRequest`/`RunAcquisitionV2WorkflowResult`/`V2WorkflowSeason` 类型随迁（workflow-v2 re-export 保出口名，bridge/测试零改动）
- `acquisition-v2/workflow-v2.ts` 变成纯阶段组合（①→②→③→no-op早退→④⑤⑥连段），~60 行；orchestrator 本体（TaskSandbox/预搜/字幕三闸门/tv 分发）作为器件不动
- 注释语义保留：④ 是全链路唯一真实搜索/转存/LLM token 消耗点，③判空 no-op 不进 ④
- 验证：tsc exit 0；vitest 12 文件 68 用例全绿（v2-workflow / v2-run-tv / v2-orchestrator / orchestrator-subtitle / v2-subtitle / v2-bridge / v2-acceptance / v2-acceptance-multiseason + 队列回归 worker / v2-full-chain / v2-series-queue / type3-worker）

### 17. 步骤④——stages/persist.ts：⑦落库收口，pipeline 转真组合

**提交**: （本次）`refactor(consumption): 步骤④ 落库阶段收口，pipeline 转真组合`

- 新增 `consumption/stages/persist.ts`：⑦写-only 的四种落库形态全部自 runner-v2 逐字迁入 —— `persistSingleSeason`（type2/type3 单季）、`persistSeriesSeasons`（type1 逐季 _sN，证据/通知只挂第一条）、`persistSeriesLockRun`（type1 claimed 锁 run 收尾，步骤① 暂居 pipeline 的尾段归位）、`persistMovieRun`（movie 单记录）；`progressAndTraceSink`（活动页进度+agent_steps trace 合并写路径）与 `resolveNow`（finishedAt 跑后盖章语义）同步迁入
- `pipeline.ts`：type2/type1/movie 分支从"转发 runner 包装"升级为**真实 ①–⑦ 组合**（runTvAcquisitionV2/runMovieAcquisitionV2 + persist.*，neededHint/priorObtained/seasons 形状逐一对位）；type3 分支暂留转发（runType3MonitoringV2AndPersist 仍是巡检唯一实现点，步骤⑥ 巡检直调时收口，避免双份对账漂移）
- `runner-v2.ts` 瘦身：本地 persistSingleSeason/progressAndTraceSink/resolveNow 删除、series/movie 内联落库段替换为 persist.ts 调用 —— 过渡期仅剩"巡检宿主 + 旧 API 薄包装"（v2-runner-persist 测试面不动），步骤⑥ 物理删除
- 验证：tsc exit 0；vitest 13 文件 97 用例全绿（v2-runner-persist / worker / v2-series-queue / v2-full-chain / movie-command-worker / type3-worker / handle-workflow-failure / run-retry-transitions / cancel-queued / agent-trace-integration / v2-bridge / v2-movie-workflow / notification-report）

### 18. 步骤⑤——fast-path 拆分：consumption/fast-path/{budgets,steps,landing,tv,movie}.ts + LandingVerdict

**提交**: （本次）`refactor(consumption): 步骤⑤ fast-path 拆分为五模块并落地 LandingVerdict`

- 1375 行单体 `acquisition-v2/fast-path.ts` 按 design §5/§7 拆分（装配脚本行切片搬运，逐字等价；原文件退居 15 行兼容壳 re-export，orchestrator/测试引用面零改动）：
  - `budgets.ts`：三常量（3/10/3 及血泪注释逐字保留）+ design §5 的 `Budgets`/`DEFAULT_BUDGETS`（业务循环保留直读常量，同源值，行为零变化）
  - `steps.ts`：stepLog/emitStep/logStorageProvider（`[mediary-run]` 文案唯一出处）+ FastPathOptions/Result + nextCandidate/concludeUncovered/fileBaseName/gradeDistribution
  - `landing.ts`：tryEpisodeMapping(§2.2)/computeKnownEpisodeRange/aliasesFallbackReSearch(§E primary 快照恢复) + 从主循环抽出的 **LandingVerdict 七值状态机** `closeOutTvLanding`（systemic/dead/clean/mapped_clean/accept/retry_other/abandon；15 个 return 点行级手术，日志与沙盒调用顺序逐字不变；死链不占转存预算的语义由"dead 分支不触 attempted.add + deadRetries 随判定带出"原样承载）
  - `tv.ts`：runFastPathAcquisition（落点检查→评分→兜底重搜→唯一A/选片仲裁→循环驱动 closeOutTvLanding→耗尽尾段）
  - `movie.ts`：runMovieFastPathAcquisition + clearMovieLanding + landSubtitlesForMovie（字幕软目标语义逐字保留）
- 验证：tsc exit 0；vitest 16 文件 160 用例全绿（fast-path 27 / movie-fast-path / repetition-stop 预算 / staging-digest / finalize-landing / episode-code / keyword-references-title / v2-orchestrator / orchestrator-subtitle / v2-subtitle + e2e full-chain/worker/series/type3/acceptance×2）

### 19. 步骤⑥——收敛：runner-v2 整体退场、三 clone 合一、巡检直调 pipeline、fast-path 壳删除

**提交**: （本次）`refactor(consumption): 步骤⑥ 收敛——runner-v2 退场与巡检直调落地`

- `runner-v2.ts`（17KB、4 个 `*AndPersist` 包装）删除：type3 巡检语义（priorObtained= DB obtained 标记、neededHint= aired∧¬obtained 计数、单季落库）逐字接管进 `consumption/pipeline.ts` 新 type3 真组合分支；movie/type2/type1 早已在 ④ 收口。
- `worker.ts` 三份同构认领 clone → 统一 `runQueuedConsumption(kind, input)`（kind 由 `QUEUE_CONSUMPTION_ORDER = [type2_init, type1_package_init, movie_init]` 优先级表驱动）+ `runNextQueuedConsumption` 单认领循环；三个 `runQueued*` 公共导出保留为一行转发（类型签名逐字不变，偏差 D 收尾）。
- 决策 1 落地：`runScheduledType3Monitoring` 改 `buildPatrolConsumptionContext`（context.ts 新增）→ `consumeClaimedRun`；`patrolMovie` 改合成 `PersistedWorkflowRunSnapshot`（movie 消费只读 runId/归属/title/season，证据数组由 ⑦ 重建）→ 同一入口。巡检自带 catch 原样（不重试/保留 episode 态/写 failed，偏差 C）。
- `acquisition-v2/fast-path.ts` 兼容壳删除：orchestrator 与 fast-path/movie-fast-path 测试改指 `consumption/fast-path/{tv,movie}.js`；index.ts 摘除 runner-v2 导出行。
- apps/web `runNextQueuedWorkflow` 三段式 → 单次 `runNextQueuedConsumption`（逐字段等价：父级字段各 kind 互不读取；resourceProvider 单 tick 装配 3→1 次，纯减量；`runNextQueuedWorkflow` 导出名不变，两个 web 测试仅 mock 该外壳、零改动）。
- 测试改线：v2-runner-persist.test.ts / agent-trace-integration.test.ts 由 runner 包装入口改为合成快照 + 直调 pipeline（断言与记录形状全保留）。
- 验证：`tsc -p tsconfig.workflow-check.json` exit 0；tests 目录单包 tsc 仅余基线同款 `yaml` 缺依赖噪音（main 亦如此，借用树环境限制）；vitest 19 文件 168 用例全绿（含 worker/type3-worker/movie-command-worker/v2-series-queue/v2-full-chain/acceptance×2 端到端）。apps/web 整包 tsc 在本借用树不可行（react/next 依赖缺失，基线同状）。

### 20. 步骤⑦——历史事故语义自查（重构收官验证）

**提交**: （本次）`test(consumption): 步骤⑦ 历史事故语义自查通过`

纯等价重构的最终防线是"事故回归全绿"。本轮（步骤⑥/⑦合计，NAS 轻量口径）33 个测试文件 323 用例全绿：

| 历史事故 | 回归位 | 关键断言 | 结果 |
|---|---|---|---|
| S03 假入库（PR #18） | episode-code.test.ts（22） | 单季任务 `01.mkv`→S03E01、多季禁无季规则 | ✅ |
| 夸克 `(1)` 重复归位（PR #19） | finalize-landing.test.ts | skipCodes 透传、已就位文件不重复动 | ✅ |
| 死链狂飙 45 候选 | fast-path.test.ts + budgets.ts 红线 | 死链计数 10 上限、dead 分支不触 attempted.add（不占 3 转存预算） | ✅ |
| 335 文件 staging 泄漏 | staging-cleanup.test.ts | 成败必清理挂 run 生命周期 | ✅ |
| 仲裁解析失败 | arbitrator.test.ts | 三升级点纯单次调用 + 保守降级（放弃不硬转） | ✅ |
| no-op 零搜索 | v2-workflow.test.ts | need 为空直接结束、一次搜索都不发 | ✅ |
| 日志/通知合同 | agent-trace-integration + notification-report + keyword-references-title | `[mediary-run][runId]` 步骤文案、通知 trigger 口径逐字不变 | ✅ |
| 失败语义（偏差 C） | handle-workflow-failure + worker + type3-worker | pipeline 不吞异常；队列退避重入队、巡检不重试写 failed，两口径各自 catch | ✅ |

预算红线复核：`MAX_TRANSFER_ATTEMPTS=3 / MAX_DEAD_LINK_RETRIES=10 / MAX_FALLBACK_SEARCHES=3` 唯一定义在 `consumption/fast-path/budgets.ts`；全仓 `attempted.add` 仅两处（TV 转存点 landing.ts:330、movie 转存点 movie.ts:360），死链路径零消耗——与重构前一致。

环境噪音备案：借用树缺 apps/web 运行时依赖（react/next）与 `yaml` 包，apps/web 整包 tsc、两个 web 测试与 runtime-config.test 在本机不可跑；三者与 main 基线同状，非本次重构引入。

### 21. 可观测性增强（用户批准的新范围，叠加在等价重构分支上）

**提交**: （本次）`feat(consumption): 可观测性增强——评分因果/候选证据/逐文件解析/结账行`

背景：真机冒烟（Outer Banks run）暴露日志"只有结果没有因果"。原则：**合同行一字不动**，全部走新增 stepLog 行 + AgentToolEvent payload（stdout 依旧永不打印链接，守沙盒红线）。

- L1 评分决策：primary 评分分布 + 为何进兜底/盲转/直选（tv.ts，含 gradingDecision 事件带 candidates 证据）；证据恢复：兜底耗尽回退 primary 的说明行。
- L2 候选证据：viewResourceSnapshot / gradeCandidates / 兜底评分 / 仲裁事件全部挂 candidates/pool payload（id/标题≤120/评级/判因≤3，≤30 条）。
- L3 仲裁输入输出：arbitrateSelection 事件挂 pool/reasoning/selected。
- L4 解析明细：digest 后逐文件裸数字⚠行；候选标题含数字但季号未被识别 + 落盘裸数字 → 追加「季号提示」warn 行（issue #21 的可见层）。
- L5 死链探测：判死依据行（返回 0 文件/不占转存预算计数）。
- 结账行：run 终局三出口（入库/仲裁放弃/候选耗尽）输出 转存 x/3 · 死链 x/10 · PanSou 搜索次数 · AI 升级有无。
- aliasesFallbackReSearch 返回值扩展 {rounds, restored}（内部接口，无外部消费方）。
- 测试同步：fast-path.test.ts Task D 两处精确序列断言纳入新事件 + 3 条新 payload 断言；19 文件 155 用例全绿、单包 tsc exit 0。
- 预算闸：agent-trace-sink 对 args JSON >2000 字符整体硬截为 `_truncated`——证据列表自带 1800 预算(标题≤100、判因≤2×70、id 尾 24、文件行≤48+「…另有 N 条未列」)，保证 UI 拿到的是数据而非「参数过长已省略」。
- 结账行进 agent_steps：新增 runCheckout(finalize) 事件（入库/仲裁放弃/候选耗尽三出口），活动页展开即见总开销。
- 活动页渲染：stepArgsText 自 components/activity-feed.tsx 抽为纯函数 apps/web/lib/step-args-text.ts（可单测，旧六类输出逐字不变），新增「证据: 「标题」[评级]…等 N 条」「词「kw」· 证据: …」「解析: 01.mp4 → S01E01 ⚠(裸数字,按目标季解释) ｜ …」三类摘要行。
- 测试：新增 consumption-evidence.test.ts(预算闸 4 用例) + apps/web/lib/step-args-text.test.ts(渲染 4 用例)；fast-path d1 序列同步 runCheckout；21 文件 163 用例全绿、tsc exit 0。
- 后续批次（未在本提交）：movie 路径同等对齐；apps/web 活动页「候选证据」面板（链接/提取码从 resource_snapshots 现取现显，只走 DB 证据流）。

### 22. 别名简体化 + §E 合并证据池（真机两单 no_coverage 的现场诊断产物）

**提交**: （本次）`fix(consumption): 别名补 alternative_titles 简体名,§E 恢复改合并证据池`

背景：3334 真机两单（龙族/母狮）暴露两个独立缺陷，靠 §21 的证据 payload 一眼定位：

- **别名全繁体**（龙族案）：TMDB translations 只带 zh-TW/zh-HK 名（龍族前傳/龍之家族），网盘真实用名是简体（龙之家族）。修：`getTvDetails/getMovieDetails` 的 append_to_response 加 `alternative_titles`，`parseAlternativeTitles` 解析 tv `titles[].title` / movie `alternatives[].title`；`aliasList` 顺序改为 original → **地区官方名（简体在前）** → translations——兜底 ≤3 轮的词序直接受益。URL 断言测试同步（逗号编码 %2C）。
- **§E 替换式恢复吞池**（母狮案）：恢复 primary 时把兜底轮搜到的好候选（「母狮 1-3季 合集」B 级）整个丢掉，仲裁见不到。修：恢复改**合并**——primary 优先入池 + 各轮兜底候选按 id 去重合并（不按标题去重：同名异链是常态，第一版标题去重被「预算 ≤3」测试当场打脸），重新 grade 一次（纯内存、零额外 PanSou，预算语义不变）。合并视图带 `candidateSnapshots`(id→来源快照)，tv/movie 转存改走 `candidateSnapshotId(raw, current)` 回各自 observed snapshot；狂飙防线原样保住。
- 测试：+「§E 合并池(母狮案)」「alternative_titles 简体排序」两用例；狂飙/movie twin 恢复用例在合并语义下原样通过（断言注释措辞同步）。22 文件 189 用例全绿、tsc exit 0。
- 遗留（观察项）：评分器无简繁折叠（「龍族前傳」命中的简体候选会被判低）——① 让简体词先进池后，多数场景已绕开；仍见误判再单独评估 opencc 级别方案。

### 23. 评分器简繁折叠 + stdout 命中摘要 + 活动页结构化证据行（龙族案收尾）

**提交**: （本次）`feat(consumption+web): 简繁折叠字表+stdout命中摘要+活动页结构化证据`

- **③ 简繁折叠（vendored，零运行时依赖）**：`packages/workflow/src/t2s-table.ts` 内嵌 opencc-js@1.4.2 TSCharacters 词典的「单字→单字」映射（2966 条，源文件 ~7KB；词组条目依赖上下文，标题匹配不需要）。折叠点在 `normalizeForTitleMatch` 末步（planning-search-gate.ts，grader 的标题↔别名/关键词比对全走它）：繁体别名（龍之家族）自此能认出简体资源标题（龙之家族 4K 更至10集），修「搜索命中 4 条却全判 D」。搜索词序、别名内容、提示词、评分阈值一概不动——折叠只发生在比对层。opencc-js 仅作生成工具临时安装、已从 package.json/lock 移除。**附记（再生成）**：临时 `npm i opencc-js@1.4.2` → 读 `dist/esm-lib/dict/TSCharacters.js`（`export default "t s|t s|…"`）→ 取单字符对拼 T/S 双串重写 t2s-table.ts。
- **stdout 命中摘要**：`evidenceDigestLine`（steps.ts）把评级池前 3 条「标题[评级]」+「＋N」打成一行；新增「兜底命中」（每轮兜底评分后）与「评分摘要」（tv primary/合并后、movie 评分后）stepLog——fnOS 日志不再只有分布数，池子里是什么一眼可见（仅标题+评级，无链接，红线安全）。
- **活动页结构化证据行**：`stepDetailView`（step-args-text.ts 新纯函数）从 candidates/pool/files payload 提取全量行（写入侧已预算化，渲染侧不再截条）；activity-feed.tsx StepList 有结构化行时渲染 `StepEvidence`（评级徽章 A绿/B蓝/C橙/D灰 + 标题 + 判因，files 逐行），否则回退原一行摘要。globals.css 新增 `.act-step-evidence` 系样式。
- 测试：+7（折叠单元×2、繁简全链盲转×1、摘要行×2、stepDetailView×2），并入 candidate-grader.test.ts 回归清单 → 23 文件 **217 用例全绿**；tsc workflow-check 0、TSX 语法过、opencc-js 不残留。
- §22 观察项「仍见误判再评估」→ 本条即落地（龙族/母狮两案 payload 为完整案卷）。

### 24. 移除桌面版（用户拍板：不做 Electron 桌面版）

**提交**: `467cbaf`(分支 chore/remove-desktop-release → main)

- 删除 `.github/workflows/release-desktop.yml`（v1.0.0 重发布时它被 tag push 连带触发、macOS job 网络失败、release skipped——从未产出任何东西，删除零损失）与整个 `apps/desktop/`（924K，与 web/workflow 代码零耦合）。
- 连带清理：ci.yml 的 desktop typecheck 行、根 package-lock 的 workspace 节点与 electron 系依赖（−4700 余行）、.gitignore 的 dist-app 行、build-fpk.yml 过时注释、deploy/fpk/README 图标步骤（图标早已是随仓库持久化的静态资源，不再源自 desktop 工程）。
- 保留：`deploy/fpk/manifest` 的 `desktop_applaunchname` 等字段（fnOS 术语，与桌面版无关）。
- 背景：正式 v1.0.0 已重发布至 main 合并点 `f669334`（含消费流水线重构、可观测性 §21、预算/UI 消费 §19-20 后续、别名简体化与合并证据池 §22、简繁折叠与证据可见性 §23），Release 仅挂双架构 fpk。


### 25. 仓库精简与上游断开（用户拍板：不再合并上游，独立发展）

**提交**: （本次）`chore/repo-trim` → main

**删除的死文件（77 个，全部经引用扫描=零后移除）**
- 旧外置 agent 技能体系：根 `SKILL.md`、`references/`（9 篇 clawd-media-track 手册）、`skills/mediary-scout/`——fast path 落地后无生产调用方；`acquisition-v2/skill.ts` 是独立内嵌常量，不受影响。
- Python 调研层：`tests/*.py`（5）、`scripts/{database,pan115_client,pansou_client,tmdb_client}.py`、`requirements.txt`——CI 不跑、能力已全部 TS 化。
- `scripts/` 一次性调研探针约 40 个（probe-115-* ×11、magnet-* ×5、`*-e2e`、`*-inquiry`、`quality-*`、`interrogate-*`、scheduler、send-test-notification 等）及 `_lib/`，**仅保留 `deploy.sh`（升级自检链在用）与 `sqlite-backup.sh`（备份文档推荐）**。
- `scripts/pg-backup.sh`（Postgres 已在 PR #13 移除）。
- `apps/web/components/request-series-button.tsx`（死组件，仅存注释提名，注释已同步）；`public/brands/` 五个从未支持品牌的图标（baidu/aliyun/dropbox/googledrive/onedrive）。
- 过时文档 9+ 篇：`docs/research/`（3）、`architecture-deep-dive.md`、`workflow-product-architecture.md`（两篇合计 20+ 处 Postgres 时代描述）、`HANDOFF-robustness-audit-2026-07-21.md`、`release-notes-0.3.0.md`、`bootstrap-working-notes.md`、`openclaw-type3-example.md`、`seo/SEO-STATE.md`、`pansou-self-host.md`（桌面端专属；compose 在用的 `deploy/pansou.channels.env` 保留）。
- 依赖死重：package.json 的 `playwright`、`yaml`（全库零使用）与 allowScripts 三条 electron 残留；`.gitignore` 清掉 python 缓存/playwright/重复 TODO 等失效条目。

**修复**
- **Dockerfile 失效 COPY**：`COPY scripts/reset-password.mjs` 引用的文件在 01b50d7（SQLite-only 迁移）已删除——docker 镜像构建自此一直是坏的，本次删除该 COPY 块。`docs/deploy.md` 的站主忘记密码流程随之重写（清 `accounts.password_hash` 为空串 → /login 就地设密码）。
- 站内上游链接全部指向 `CodeByZack/mediary-scout`：设置页 GitHub nameplate、demo 横幅回链、**检查更新轮询**（`deployment-update-server.ts` 的 api.github commits/main）、pansou 配置表单教程（改指 PanSou 上游项目本体）。

**README 双版重写（中英）**
- 部署主线改为 **fnOS fpk 优先 + Docker**；删除桌面版（DMG/EXE）、官网/在线 demo、LINUX DO 徽章、star-history、"致谢与上游"的上游段（技术出处致谢保留）；架构图从"沙盒 agent"更新为**消费流水线 + ≤3 次单点仲裁**的真实形态；中文版补齐 123/天翼两品牌的落后内容。
- `docs/deploy.md` 开头对比表同步改 fpk+Docker 双形态，「作者」措辞中性化。
- `site/` 目录**保留**（用户计划后续改造成自己的发布页）；vitest/CI 对其的既有接线不动。

**查证与遗留**
- LICENSE 为 **0BSD**、版权行 "Mediary Scout contributors"——独立无法律负担，文件不动。
- `workers/tmdb-proxy/` 查实是活的（CI typecheck + web 运行时默认调用），保留；其默认域名 `tmdb-proxy.mediaryscout.app` 仍为上游托管，用户计划日后自备代理与文档（`TMDB_PROXY_BASE_URL` 可覆盖）。
- `isDesktop`/`MEDIA_TRACK_DESKTOP` 代码路径（workflow-runtime → settings → pansou-config-form 小分支）桌面版移除后永假但无害，留作后续小清。

**验证**：workflow tsc（workflow-check）0 错；受影响单测（deployment-update ×2 + 消费回归清单）全绿；全库 grep 无 `fancydirty` 残留（本文件历史记录除外）、无对已删路径的引用；CI 全绿后合并。

---

## 注意事项

- `.gitignore`：追加 `*_TODO.md`、`deploy/fpk/app/server/`、`deploy/fpk/dist/`
- `deploy/fpk/`：fpk 打包目录（骨架入库，构建产物 dist/server 已被 ignore）