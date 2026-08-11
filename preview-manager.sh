#!/usr/bin/env bash
# preview-manager.sh — 统管 3100 preview 启停，PID 落文件，只需批准一次模板命令

set -euo pipefail

PREVIEW_DIR="/vol1/@appshare/com.dustinky.qwenpaw/code/mediary-scout"
WORK_DIR="/tmp/mediary-preview"
PID_FILE="$WORK_DIR/preview-3100.pid"
LOG_FILE="$WORK_DIR/preview-3100.log"
PORT=3100

# 环境变量（fake 模式：无需 LLM key；如需真实 LLM 改 vercel-ai 并在 UI 配好 key）
export MEDIA_TRACK_AGENT_ADAPTER=fake
export MEDIA_TRACK_SQLITE_PATH=/tmp/mediary-preview/mediary-preview.db
export PANSOU_BASE_URL=http://127.0.0.1:3001
export MEDIA_TRACK_SEARCH_PROVIDER=tmdb
export MEDIA_TRACK_WORKFLOW_ADAPTER=pansou
export MEDIA_TRACK_DEFAULT_STORAGE_BRAND=quark

mkdir -p "$WORK_DIR"

is_running() {
    local pid=""
    [[ -f "$PID_FILE" ]] && pid=$(cat "$PID_FILE" 2>/dev/null || echo "")
    [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && echo "$pid" || echo ""
}

start() {
    local existing_pid=$(is_running)
    if [[ -n "$existing_pid" ]]; then
        echo "⚠️  已在运行 (PID: $existing_pid)"
        return 0
    fi

    echo "🚀 启动 preview (port $PORT) ..."
    cd "$PREVIEW_DIR"
    nohup npx next start apps/web -p "$PORT" -H 0.0.0.0 \
        > "$LOG_FILE" 2>&1 &
    local pid=$!
    echo "$pid" > "$PID_FILE"
    sleep 2
    if kill -0 "$pid" 2>/dev/null; then
        echo "✅ 启动成功 (PID: $pid)"
        echo "📋 日志: tail -f $LOG_FILE"
        echo "🌐 访问: http://127.0.0.1:$PORT"
    else
        echo "❌ 启动失败，查看日志: cat $LOG_FILE"
        rm -f "$PID_FILE"
        return 1
    fi
}

stop() {
    local pid=$(is_running)
    if [[ -z "$pid" ]]; then
        echo "ℹ️  未运行"
        return 0
    fi

    echo "🛑 停止 preview (PID: $pid) ..."
    kill -TERM "$pid" 2>/dev/null
    local i=0
    while kill -0 "$pid" 2>/dev/null && [[ $i -lt 10 ]]; do
        sleep 1
        ((i++))
    done
    if kill -0 "$pid" 2>/dev/null; then
        echo "⚠️  进程未退出，强制杀掉"
        kill -KILL "$pid" 2>/dev/null
        sleep 1
    fi
    rm -f "$PID_FILE"
    echo "✅ 已停止"
}

restart() {
    stop
    start
}

status() {
    local pid=$(is_running)
    if [[ -n "$pid" ]]; then
        echo "🟢 RUNNING (PID: $pid)"
        ss -tlnp 2>/dev/null | grep ":$PORT " || true
    else
        echo "🔴 STOPPED"
    fi
}

logs() {
    tail -f "$LOG_FILE" 2>/dev/null || echo "日志文件不存在: $LOG_FILE"
}

case "${1:-status}" in
    start)   start ;;
    stop)    stop ;;
    restart) restart ;;
    status)  status ;;
    logs)    logs ;;
    *)       echo "用法: $0 {start|stop|restart|status|logs}" ;;
esac