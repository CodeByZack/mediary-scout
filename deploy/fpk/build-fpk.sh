#!/bin/bash
# MediaTrack (mediary-scout) — 飞牛 fnOS fpk 一键构建 + 打包脚本
#
# 用法：
#   ./deploy/fpk/build-fpk.sh             # 构建 web + 填充 app/server + 打包（ARCH 默认按 uname 探测）
#   VERSION=1.2.0 ./deploy/fpk/build-fpk.sh  # 指定 fpk 版本号（默认读 package.json，缺省 1.0.0）
#   ARCH=x86 ./deploy/fpk/build-fpk.sh    # 指定架构（arm|x86，决定 manifest platform 与产物名）
#   FNPACK_BIN=/path/to/fnpack ./deploy/fpk/build-fpk.sh  # 指定 fnpack 可执行文件（默认 PATH 里的 fnpack）
#   FPK_MODE=test ./deploy/fpk/build-fpk.sh     # 测试版：appname=mediary-scout-dev、端口 3334，
#                                                独立数据目录，装/卸都不影响正式版数据
#
# 产物：
#   deploy/fpk/dist/mediary-scout-<ARCH>.fpk        （release：arm → mediary-scout-arm.fpk，x86 → mediary-scout-x86.fpk）
#   deploy/fpk/dist/mediary-scout-dev-<ARCH>.fpk    （test：arm → mediary-scout-dev-arm.fpk，x86 → mediary-scout-dev-x86.fpk）
#
# 前置条件（本机已具备）：
#   - node + npm（构建机与 NAS 同架构 + Node 24，ABI 匹配；CI 里 setup-node 用 24）
#   - fnpack（/usr/local/bin/fnpack；CI 里从 https://static2.fnnas.com/fnpack/ 下载对应架构二进制）
# 图标（ICON.PNG / ICON_256.PNG / app/ui/images/*.png）为一次性静态资源，
# 首次已生成并随 fpk 目录持久保留，后续打包不再重新生成。
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "${SCRIPT_DIR}/../.." && pwd)"
FPK_DIR="${SCRIPT_DIR}"
DIST_DIR="${FPK_DIR}/dist"

cd "${REPO_ROOT}"

# ---- 0. 架构：ARCH 环境变量 > uname 探测（arm | x86）----
if [ -z "${ARCH:-}" ]; then
    case "$(uname -m)" in
        x86_64|amd64) ARCH=x86 ;;
        aarch64|arm64) ARCH=arm ;;
        *) echo "无法识别的构建架构: $(uname -m)（请显式设置 ARCH=arm 或 ARCH=x86）" >&2; exit 1 ;;
    esac
fi
case "${ARCH}" in
    arm|x86) ;;
    *) echo "ARCH 必须是 arm 或 x86，收到: ${ARCH}" >&2; exit 1 ;;
esac
echo "==> fpk arch: ${ARCH}"

# ---- 0.5 版本号：VERSION 环境变量 > package.json > 1.0.0 ----
if [ -z "${VERSION:-}" ]; then
    VERSION="$(node -e "try{const p=JSON.parse(require('fs').readFileSync('package.json','utf8'));process.stdout.write(p.version||'')}catch(e){process.stdout.write('')}" 2>/dev/null || true)"
fi
VERSION="${VERSION:-1.0.0}"
echo "==> fpk version: ${VERSION}"

# ---- 0.6 fnpack：FNPACK_BIN 环境变量 > PATH ----
# ⚠️ 必须用 fnpack 1.2.0！fnpack 1.2.1（static2 上 arm64 最新，2026-08-12 实测）打包时
#   会把正常符号链接改写为指向自身的死链；fnOS 安装器对死链 acl_get_file 跟随目标
#   死循环（ELOOP），报 10234 "set app dir permissions failed / 设置目录权限失败"，
#   任何内容用 1.2.1 打都装不上。1.2.0 原样打包、正常可装。两者 --help 版本号都显示
#   1.2.0 无法程序化区分（sha256 各异），请勿自行升级！
FNPACK_BIN="${FNPACK_BIN:-fnpack}"
command -v "${FNPACK_BIN}" >/dev/null 2>&1 || { echo "fnpack 不存在: ${FNPACK_BIN}（本机 /usr/local/bin/fnpack，CI 由 workflow 下载）" >&2; exit 1; }
echo "==> fnpack: ${FNPACK_BIN}"

# ---- 0.7 打包模式：FPK_MODE（release 正式版 | test 测试版）----
# test 模式 = 换 appname 装成独立应用（mediary-scout-dev）：独立数据目录
# /vol1/@appdata/mediary-scout-dev、独立端口 3334，装/卸都不碰正式版数据，
# 适合反复试装验证（尤其是 CI 产物），正式版一直能用。
FPK_MODE="${FPK_MODE:-release}"
case "${FPK_MODE}" in
    release)
        APPNAME="mediary-scout"
        DISPLAY_NAME="MediaTrack"
        SERVICE_PORT="3333"
        ;;
    test)
        APPNAME="mediary-scout-dev"
        DISPLAY_NAME="MediaTrack (测试版)"
        SERVICE_PORT="3334"
        ;;
    *)
        echo "FPK_MODE 必须是 release 或 test，收到: ${FPK_MODE}" >&2; exit 1 ;;
esac
echo "==> fpk mode: ${FPK_MODE} (appname=${APPNAME}, service_port=${SERVICE_PORT})"

# ---- 1. 正式构建（tsc workflow + next build standalone，约 1 分钟）----
echo "==> [1/3] npm run build:web ..."
npm run build:web

# ---- 2. 填充 app/server（standalone 三件套）----
echo "==> [2/3] 填充 app/server ..."
rm -rf "${FPK_DIR}/app/server"
mkdir -p "${FPK_DIR}/app/server"

STANDALONE="${REPO_ROOT}/apps/web/.next/standalone"
[ -d "${STANDALONE}" ] || { echo "standalone 产物缺失: ${STANDALONE}" >&2; exit 1; }

# 1) standalone 整体
cp -a "${STANDALONE}/." "${FPK_DIR}/app/server/"
# 2) static → apps/web/.next/static
mkdir -p "${FPK_DIR}/app/server/apps/web/.next/static"
cp -a "${REPO_ROOT}/apps/web/.next/static/." "${FPK_DIR}/app/server/apps/web/.next/static/"
# 3) public → apps/web/public
mkdir -p "${FPK_DIR}/app/server/apps/web/public"
cp -a "${REPO_ROOT}/apps/web/public/." "${FPK_DIR}/app/server/apps/web/public/"

echo "    app/server 大小: $(du -sh "${FPK_DIR}/app/server" | cut -f1)"

# ---- 2.5 清理 sharp 的 musl 变体（glibc 环境用不到，减小 fpk 体积）----
# npm 在 linux 下会把 glibc/musl 两种 libc 的 sharp 原生二进制都装进 @img（os/cpu 过滤正常、
# libc 过滤失效），目标 NAS（飞牛 fnOS）与 CI 均为 glibc，musl 变体完全用不上，删掉。
# 仅匹配 *linuxmusl*（arm/x86 通用，同时覆盖 sharp-libvips-linuxmusl-* 与 sharp-linuxmusl-*），
# darwin/win32/wasm32 等其他平台变体不会被 npm 装进 linux，不需要处理。
IMG_DIR="${FPK_DIR}/app/server/node_modules/@img"
if [ -d "${IMG_DIR}" ]; then
    MUSL_COUNT=0
    while IFS= read -r musl_dir; do
        [ -z "${musl_dir}" ] && continue
        echo "    移除 sharp musl 变体: $(basename "${musl_dir}")"
        rm -rf "${musl_dir}"
        MUSL_COUNT=$((MUSL_COUNT + 1))
    done < <(find "${IMG_DIR}" -maxdepth 1 -type d -name '*linuxmusl*' 2>/dev/null || true)
    if [ "${MUSL_COUNT}" -eq 0 ]; then
        echo "    @img 下无 sharp musl 变体，无需清理"
    else
        echo "    共移除 ${MUSL_COUNT} 个 sharp musl 变体目录"
    fi
else
    echo "    @img 目录不存在，跳过 sharp musl 清理"
fi

# ---- 2.55 消除 Next standalone 符号链接（官方 fnpack 必踩坑）----
# 官方 fnpack（static2.fnnas.com 的 1.2.0 / 1.2.1 均如此，2026-08-12 实测）打包时会把
# 源内容里的任何符号链接改写为指向自身的死链；fnOS 安装器对死链 acl_get_file 跟随目标
# 死循环（ELOOP），报 10234 "set app dir permissions failed / 设置目录权限失败"。
# 本项目符号链接只出现在 Next standalone 的 .next/node_modules/（外部包 hash 映射，
# 如 better-sqlite3-<hash>、pg-<hash>，hash 随构建变化，故按目录扫描而非写死名字）。
# 处理：链接目标存在 → 替换为真实拷贝（运行时 require 靠拷贝文件解析，不能只删）；
# dangling → 删除。
REPLACED_LINKS=0
while IFS= read -r -d '' link; do
    abs="$(realpath -m "$link" 2>/dev/null || true)"
    rel="${link#"${FPK_DIR}"/app/}"
    if [ -n "$abs" ] && [ -e "$abs" ]; then
        rm -f "$link"
        cp -a "$abs" "$link"
        echo "    符号链接→真实拷贝: ${rel}"
    else
        rm -f "$link"
        echo "    删除 dangling 链接: ${rel}"
    fi
    REPLACED_LINKS=$((REPLACED_LINKS + 1))
done < <(find "${FPK_DIR}/app/server" -path "*/.next/node_modules/*" -type l -print0 2>/dev/null || true)
if [ "${REPLACED_LINKS}" -eq 0 ]; then
    echo "    .next/node_modules 下无符号链接，跳过处理"
else
    echo "    共处理 ${REPLACED_LINKS} 个符号链接"
fi
# 防御：.next/node_modules 之外若出现符号链接，fnpack 同样会改写成死链，需人工关注
EXTRA_LINKS="$(find "${FPK_DIR}/app" -type l ! -path "*/.next/node_modules/*" 2>/dev/null | head -5 || true)"
if [ -n "${EXTRA_LINKS}" ]; then
    echo "    ⚠️ 警告：以下位置存在符号链接（fnpack 会改写为死链）："
    echo "${EXTRA_LINKS}" | sed "s#${FPK_DIR}/app/##" | sed 's/^/        /'
fi

# ---- 2.6 确保 cmd/wizard 脚本可执行（git mode 可能丢失，打包前强制补上）----
chmod +x "${FPK_DIR}"/cmd/* "${FPK_DIR}"/wizard/*
echo "    cmd/wizard 脚本执行位已确认"

# ---- 2.7 app/ui/config 桌面入口随模式改写 ----
# fnpack 校验：".url" 下的入口键名必须以 appname 开头（如 mediary-scout.Application）；
# 端口/标题也必须与当前模式一致。release 和 test 都全量写一次，避免残留污染。
UI_CONFIG="${FPK_DIR}/app/ui/config"
if [ -f "${UI_CONFIG}" ]; then
    APPNAME="${APPNAME}" SERVICE_PORT="${SERVICE_PORT}" DISPLAY_NAME="${DISPLAY_NAME}" node -e '
const fs = require("fs");
const p = process.argv[1];
const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
const url = cfg[".url"] || {};
for (const k of Object.keys(url)) delete url[k];
url[process.env.APPNAME + ".Application"] = {
    title: process.env.DISPLAY_NAME,
    icon: "images/icon_{0}.png",
    type: "iframe",
    protocol: "http",
    port: process.env.SERVICE_PORT,
    allUsers: true,
};
fs.writeFileSync(p, JSON.stringify(cfg, null, 4) + "\n");
console.log("    app/ui/config 入口已改为 " + process.env.APPNAME + ".Application (port=" + process.env.SERVICE_PORT + ")");
' "${UI_CONFIG}"
else
    echo "    app/ui/config 不存在，跳过"
fi

# ---- 3. 写入 appname/显示名/端口/版本号/平台 + fnpack 打包 ----
echo "==> [3/3] fnpack build ..."
# 无论 release 还是 test 都全量写一次，避免上次 test 残留污染 release（反之亦然）。
sed -i.bak "s/^appname[[:space:]]*=.*/appname                    = ${APPNAME}/" "${FPK_DIR}/manifest"
sed -i.bak "s/^display_name[[:space:]]*=.*/display_name               = ${DISPLAY_NAME}/" "${FPK_DIR}/manifest"
sed -i.bak "s/^desktop_applaunchname[[:space:]]*=.*/desktop_applaunchname      = ${APPNAME}.Application/" "${FPK_DIR}/manifest"
sed -i.bak "s/^service_port[[:space:]]*=.*/service_port               = ${SERVICE_PORT}/" "${FPK_DIR}/manifest"
sed -i.bak "s/^version[[:space:]]*=.*/version                    = ${VERSION}/" "${FPK_DIR}/manifest"
sed -i.bak "s/^platform[[:space:]]*=.*/platform                   = ${ARCH}/" "${FPK_DIR}/manifest"
rm -f "${FPK_DIR}/manifest.bak"

if [ "${FPK_MODE}" = "test" ]; then
    FPK_NAME="mediary-scout-dev-${ARCH}.fpk"
else
    FPK_NAME="mediary-scout-${ARCH}.fpk"
fi

rm -rf "${DIST_DIR}"
mkdir -p "${DIST_DIR}"
rm -f "${FPK_DIR}/${FPK_NAME}"

cd "${FPK_DIR}"
# fnpack 输出名固定为 manifest 的 appname（release: mediary-scout.fpk / test: mediary-scout-dev.fpk），
# 按模式+架构重命名到 dist/。
"${FNPACK_BIN}" build -d .
mv "${APPNAME}.fpk" "${DIST_DIR}/${FPK_NAME}"

echo
echo "======================================================"
echo " fpk 产物: ${DIST_DIR}/${FPK_NAME}"
ls -lh "${DIST_DIR}/${FPK_NAME}"
echo "======================================================"
