#!/bin/bash
# 诗境 · 山河 —— 一键停止（双击本文件即可）
# 用法：./stop.command        或        ./stop.command 8080

DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${1:-8777}"
PIDFILE="$DIR/.server.pid"
STOPPED=0

# 1) 走 start.command 留下的 pid 文件
if [ -f "$PIDFILE" ]; then
  PID="$(cat "$PIDFILE")"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null && STOPPED=1
    sleep 0.3
    kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null && STOPPED=1
  fi
  rm -f "$PIDFILE"
fi

# 2) 兜底：按端口找还在监听的进程（手敲 python3 serve.py 起的也能停掉）
for PID in $(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null); do
  kill "$PID" 2>/dev/null && STOPPED=1
done

if [ "$STOPPED" = "1" ]; then
  echo "✅ 已停止端口 ${PORT} 上的服务器"
else
  echo "ℹ️ 没有发现运行中的服务器（端口 ${PORT}）"
fi
