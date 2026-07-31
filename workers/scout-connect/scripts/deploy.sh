#!/bin/sh
# scout-connect 部署入口。**别再直接跑 `wrangler deploy`。**
#
# 为什么需要这层包装 —— 一晚上两次同类事故:
#
#  1. 切 live 时漏了 PADDLE_WEBHOOK_SECRET。前面三项全对,于是交易能创建、
#     结账窗能开、用户能付款,但 webhook 全部 401 → **钱照收,货不发,零报错**。
#  2. 从 main 直接 deploy,而 PADDLE_ENVIRONMENT=production 那个改动还在未合并
#     的分支里 → 把生产**打回了 sandbox**。
#
# 共性:`wrangler deploy` 会把**当前工作区**的 wrangler.jsonc 整体推上生产,
# 包括你以为早就生效的开关。它不知道你的分支落后了,也不会问。
set -eu

cd "$(dirname "$0")/.."
REPO_ROOT=$(git rev-parse --show-toplevel)

# ---- 1) 工作区必须干净 ----
# 脏工作区部署 = 生产跑着一份 git 里不存在的代码,出事没法回溯。
if [ -n "$(git status --porcelain -- . 2>/dev/null)" ]; then
  echo "❌ worker 目录有未提交改动。先 commit/push,再部署(铁律:代码一律经 GitHub)。" >&2
  git status --short -- . >&2
  exit 1
fi

# ---- 2) 必须与 origin/main 一致 ----
# 这条直接对应第 2 次事故。
git -C "$REPO_ROOT" fetch -q origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [ "$LOCAL" != "$REMOTE" ]; then
  echo "❌ HEAD 与 origin/main 不一致 —— 你可能在从一个落后/未合并的分支部署。" >&2
  echo "   HEAD:        $LOCAL" >&2
  echo "   origin/main: $REMOTE" >&2
  echo "   wrangler deploy 会用**当前工作区**的 wrangler.jsonc 覆盖生产," >&2
  echo "   包括 PADDLE_ENVIRONMENT 这类开关。这正是把生产打回 sandbox 的方式。" >&2
  echo "   确实要这么做:DEPLOY_ALLOW_DIVERGED=1 ./scripts/deploy.sh" >&2
  [ "${DEPLOY_ALLOW_DIVERGED:-}" = "1" ] || exit 1
  echo "   ⚠️ DEPLOY_ALLOW_DIVERGED=1,继续。" >&2
fi

# ---- 3) 亮出即将生效的 Paddle 环境 ----
# 不做拦截,只做**无法忽视的确认**:这个值决定真钱走 sandbox 还是 live。
PADDLE_ENV=$(sed -n 's/.*"PADDLE_ENVIRONMENT"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' wrangler.jsonc | head -1)
echo "→ 即将部署的 PADDLE_ENVIRONMENT = ${PADDLE_ENV:-(未设,按 production 处理)}"
if [ "$PADDLE_ENV" = "sandbox" ]; then
  echo "  ⚠️ sandbox:真实付款会失败(live client token 打沙箱环境,结账窗必然报错)。" >&2
fi

# ---- 4) 门禁 ----
echo "→ typecheck"
npx tsc -p tsconfig.json --noEmit
echo "→ tests"
(cd "$REPO_ROOT" && npx vitest run workers/scout-connect/ --silent)

echo "→ wrangler deploy"
env -u CF_API_TOKEN npx wrangler deploy "$@"

# ---- 5) 部署后自检 ----
# secret 有三项(API key / webhook secret / client token)不在代码里,测试测不到。
# 这里做能在外部观测到的最低验证。
echo "→ 部署后自检"
sleep 3
BUY=$(curl -fsS https://mediaryconnect.app/buy 2>/dev/null || echo "")
if [ "$PADDLE_ENV" != "sandbox" ] && printf '%s' "$BUY" | grep -q 'Environment.set("sandbox")'; then
  echo "❌ 线上 /buy 仍在注入 sandbox 环境 —— 部署没生效或配置不一致。" >&2
  exit 1
fi
if ! printf '%s' "$BUY" | grep -q "eventCallback"; then
  echo "❌ 线上 /buy 缺 eventCallback —— 用户付完款界面会一动不动(已发生过的事故)。" >&2
  exit 1
fi
CK=$(curl -s -o /dev/null -w "%{http_code}" -X POST https://mediaryconnect.app/api/checkout \
  -H "content-type: application/json" -d '{"price_id":"x"}')
if [ "$CK" = "503" ]; then
  echo "❌ /api/checkout 返回 503 = PADDLE_API_KEY 未配置或价格白名单为空。用户买不了。" >&2
  exit 1
fi
echo "✅ 部署完成,自检通过(PADDLE_ENVIRONMENT=$PADDLE_ENV, /api/checkout=$CK)"
echo "   注意:webhook 验签只能靠一次真实付款验证 —— secret 配错时表现为"
echo "   「钱照收、货不发、服务端零报错」。见 src/paddle-config-guard.test.ts。"
