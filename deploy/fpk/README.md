# MediaTrack — 飞牛 fnOS fpk 打包（原生应用）

本目录为 [mediary-scout](../..)（Next.js 应用，`apps/web`）的 fnOS **原生应用**打包方案，
产物是飞牛应用中心可手动安装的 `.fpk` 文件（非 Docker）。

## 目录结构

```
deploy/fpk/
├── manifest            # 应用元数据（依赖 nodejs_v24、端口 3333、ctl_stop 等）
├── ICON.PNG            # 应用中心图标 64x64（构建脚本生成）
├── ICON_256.PNG        # 应用中心大图标 256x256（构建脚本生成）
├── config/
│   ├── privilege       # run-as: package
│   └── resource        # 空（数据全在 TRIM_PKGVAR，无共享目录需求）
├── cmd/
│   ├── main            # start/stop/status 生命周期脚本
│   └── *_init / *_callback  # install/uninstall/upgrade/config 回调（标准空实现）
├── app/
│   ├── ui/config       # 桌面图标 iframe 入口 → http://127.0.0.1:3333
│   ├── ui/images/      # 桌面图标（构建脚本生成）
│   └── server/         # ⚠️ 构建产物，由 build-fpk.sh 填充，不提交 git
├── wizard/
│   ├── install         # 安装向导（信息提示）
│   └── uninstall       # 卸载向导（是否删除数据）
├── gen-icons.py        # 图标生成脚本（Pillow）
├── build-fpk.sh        # 一键构建 + 打包脚本
└── README.md
```

## 一键构建 + 打包

```bash
./deploy/fpk/build-fpk.sh
# 指定版本号（默认读 package.json，缺省 1.0.0）：
# VERSION=1.2.0 ./deploy/fpk/build-fpk.sh
```

脚本做的事：

1. `npm run build:web`（tsc workflow + `next build` standalone，约 1 分钟）
2. 清空并填充 `app/server/`（standalone 三件套）：
   - `apps/web/.next/standalone/` 整体 → `app/server/`
   - `apps/web/.next/static/` → `app/server/apps/web/.next/static/`
   - `apps/web/public/` → `app/server/apps/web/public/`
3. 从 `apps/desktop/build/icon.png` 生成 4 个图标（Pillow，缺则 ffmpeg 兜底）
4. `fnpack build` 产出 `deploy/fpk/dist/mediary-scout.fpk` 并打印大小

> 产物不入 git：`deploy/fpk/app/server/`、`deploy/fpk/dist/` 已在 `.gitignore`。

## 安装（NAS 上）

1. 在飞牛应用中心安装 **Node.js 24** 运行时应用（本 fpk 声明 `install_dep_apps=nodejs_v24`，
   依赖会自动处理；fpk **不**内置 node_modules）。
2. 应用中心 → 手动安装 → 选择 `deploy/fpk/dist/mediary-scout.fpk`。
3. 安装完成后打开飞牛桌面上的 **MediaTrack** 图标，或浏览器访问
   `http://<NAS地址>:3333` 完成初始化（设置页扫码连 115、填 LLM key 等）。

## 数据目录（升级不丢）

| 内容 | 位置 |
| --- | --- |
| 数据库 | `${TRIM_PKGVAR}/mediary.db`（即 `/vol1/@appdata/mediary-scout/mediary.db`） |
| 运行日志 | `${TRIM_PKGVAR}/mediary.log` |
| PID 文件 | `${TRIM_PKGVAR}/mediary.pid` |

`TRIM_PKGVAR` 是飞牛的应用数据目录，**升级/更新 fpk 不会清除**，所以数据、账号、
设置都会保留。

## 升级流程

1. 拉取新代码 → 修改 `deploy/fpk/cmd/main` 里的环境变量（如需）
2. `./deploy/fpk/build-fpk.sh`（可带 `VERSION=x.y.z`）
3. 应用中心 → MediaTrack → 更新 → 选择新 `.fpk`
4. 数据保留，服务自动重启

## 运行时环境变量（在 cmd/main 中设置）

| 变量 | 值 | 说明 |
| --- | --- | --- |
| `PORT` | `${TRIM_SERVICE_PORT:-3333}` | 端口 3333（避开 docker 3000 / preview 3100） |
| `HOSTNAME` | `0.0.0.0` | 监听所有网卡 |
| `MEDIA_TRACK_SQLITE_PATH` | `${TRIM_PKGVAR}/mediary.db` | SQLite 数据库，数据目录持久化 |
| `MEDIA_TRACK_WORKFLOW_ADAPTER` | `pansou` | 网盘搜索，官方源（so.252035.xyz） |
| `MEDIA_TRACK_SEARCH_PROVIDER` | `tmdb` | 剧集元数据 |
| `MEDIA_TRACK_AGENT_ADAPTER` | `vercel-ai` | pansou + 115 必需（不要改成 real） |
| `MEDIA_TRACK_STORAGE_ADAPTER` | `115` | 存储适配器（对齐旧正式配置，可改） |
| `MEDIA_TRACK_DEMO_SEED` | `0` | 与 compose 一致，不种演示数据 |

明确**未设置**（对齐 compose 缺省行为）：`PANSOU_BASE_URL`（用官方源默认值，设置页可改）、
`MEDIA_TRACK_ALLOWED_ORIGINS`（iframe 同源无需跨域）、`MEDIA_TRACK_AGENT_LOG`（排障可选）、
`TUNNEL_TOKEN`（Cloudflare Tunnel 可选）。

如需修改：编辑 `deploy/fpk/cmd/main` 中的 `export` 后重新打包即可。

## 架构与 ABI

- `platform = arm`（aarch64）。构建机与目标 NAS 同为 aarch64 + Node 24
  （ABI 137），standalone 内随包的 `better-sqlite3` 原生模块直接可用，
  无需在 NAS 上重新编译。

## 已知取舍 / 待确认

- 依赖 `nodejs_v24` 由飞牛应用中心提供；若中心版本与构建机 Node 24 ABI 不一致
  （node_modules 里的原生模块），需在 NAS 上重建 better-sqlite3——当前两者同为
  v24.13.1（modules=137），无此问题。
- `config/resource` 为空：MediaTrack 存储走 115 云盘，无本地共享目录需求。
