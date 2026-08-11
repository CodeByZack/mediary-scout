# FORK-CHANGES — 本仓库 fork 后的改动记录

> 记录自 fork 上游 `fancydirty/mediary-scout`（main）以来，本分支（`feat/canonical-video-rename`）做出的全部改动。
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

---

## 注意事项

- `.gitignore`：追加 `*_TODO.md`、`deploy/fpk/app/server/`、`deploy/fpk/dist/`
- `apps/desktop/build/icon.png.bak`：原始图标备份（本地保留，不入库）
- `deploy/fpk/`：fpk 打包目录（骨架入库，构建产物 dist/server 已被 ignore）
