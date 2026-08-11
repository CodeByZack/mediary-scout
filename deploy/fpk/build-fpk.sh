#!/bin/bash
# MediaTrack (mediary-scout) — 飞牛 fnOS fpk 一键构建 + 打包脚本
#
# 用法：
#   ./deploy/fpk/build-fpk.sh             # 构建 web + 填充 app/server + 打包
#   VERSION=1.2.0 ./deploy/fpk/build-fpk.sh  # 指定 fpk 版本号（默认读 package.json，缺省 1.0.0）
#
# 产物：
#   deploy/fpk/dist/mediary-scout.fpk
#
# 前置条件（本机已具备）：
#   - node + npm（构建机与 NAS 同为 aarch64 + Node 24，ABI 匹配）
#   - fnpack（/usr/local/bin/fnpack）
# 图标（ICON.PNG / ICON_256.PNG / app/ui/images/*.png）为一次性静态资源，
# 首次已生成并随 fpk 目录持久保留，后续打包不再重新生成。
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "${SCRIPT_DIR}/../.." && pwd)"
FPK_DIR="${SCRIPT_DIR}"
DIST_DIR="${FPK_DIR}/dist"

cd "${REPO_ROOT}"

# ---- 0. 版本号：VERSION 环境变量 > package.json > 1.0.0 ----
if [ -z "${VERSION:-}" ]; then
    VERSION="$(node -e "try{const p=JSON.parse(require('fs').readFileSync('package.json','utf8'));process.stdout.write(p.version||'')}catch(e){process.stdout.write('')}" 2>/dev/null || true)"
fi
VERSION="${VERSION:-1.0.0}"
echo "==> fpk version: ${VERSION}"

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

# ---- 3. 写入版本号 + fnpack 打包 ----
echo "==> [3/3] fnpack build ..."
sed -i.bak "s/^version[[:space:]]*=.*/version                    = ${VERSION}/" "${FPK_DIR}/manifest"
rm -f "${FPK_DIR}/manifest.bak"

rm -rf "${DIST_DIR}"
mkdir -p "${DIST_DIR}"
rm -f "${FPK_DIR}/mediary-scout.fpk"

cd "${FPK_DIR}"
fnpack build -d .
mv mediary-scout.fpk "${DIST_DIR}/"

echo
echo "======================================================"
echo " fpk 产物: ${DIST_DIR}/mediary-scout.fpk"
ls -lh "${DIST_DIR}/mediary-scout.fpk"
echo "======================================================"
