#!/bin/bash
# MediaTrack (mediary-scout) — 飞牛 fnOS fpk 一键构建 + 打包脚本
#
# 用法：
#   ./deploy/fpk/build-fpk.sh             # 构建 web + 填充 app/server + 打包（ARCH 默认按 uname 探测）
#   VERSION=1.2.0 ./deploy/fpk/build-fpk.sh  # 指定 fpk 版本号（默认读 package.json，缺省 1.0.0）
#   ARCH=x86 ./deploy/fpk/build-fpk.sh    # 指定架构（arm|x86，决定 manifest platform 与产物名）
#   FNPACK_BIN=/path/to/fnpack ./deploy/fpk/build-fpk.sh  # 指定 fnpack 可执行文件（默认 PATH 里的 fnpack）
#
# 产物：
#   deploy/fpk/dist/mediary-scout-<ARCH>.fpk     （arm → mediary-scout-arm.fpk，x86 → mediary-scout-x86.fpk）
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
FNPACK_BIN="${FNPACK_BIN:-fnpack}"
command -v "${FNPACK_BIN}" >/dev/null 2>&1 || { echo "fnpack 不存在: ${FNPACK_BIN}（本机 /usr/local/bin/fnpack，CI 由 workflow 下载）" >&2; exit 1; }
echo "==> fnpack: ${FNPACK_BIN}"

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

# ---- 3. 写入版本号 + 平台 + fnpack 打包 ----
echo "==> [3/3] fnpack build ..."
sed -i.bak "s/^version[[:space:]]*=.*/version                    = ${VERSION}/" "${FPK_DIR}/manifest"
sed -i.bak "s/^platform[[:space:]]*=.*/platform                   = ${ARCH}/" "${FPK_DIR}/manifest"
rm -f "${FPK_DIR}/manifest.bak"

FPK_NAME="mediary-scout-${ARCH}.fpk"

rm -rf "${DIST_DIR}"
mkdir -p "${DIST_DIR}"
rm -f "${FPK_DIR}/${FPK_NAME}"

cd "${FPK_DIR}"
# fnpack 输出名固定为 manifest 的 appname（mediary-scout.fpk），按架构重命名到 dist/。
"${FNPACK_BIN}" build -d .
mv mediary-scout.fpk "${DIST_DIR}/${FPK_NAME}"

echo
echo "======================================================"
echo " fpk 产物: ${DIST_DIR}/${FPK_NAME}"
ls -lh "${DIST_DIR}/${FPK_NAME}"
echo "======================================================"
