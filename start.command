#!/bin/bash
# 诗境 · 山河 —— 一键启动后端服务（双击本文件即可）
# 用法：./start.command          默认 8777 端口
#      ./start.command 8080    换端口

DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${1:-8777}"
PIDFILE="$DIR/.server.pid"
LOGFILE="$DIR/.server.log"
URL="http://127.0.0.1:${PORT}/index.html"

listening() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; }

# 端口已被监听就别重复起一个，直接开页面
if listening; then
  echo "端口 ${PORT} 已有服务在监听，直接打开：${URL}"
  open "$URL"
  exit 0
fi

echo "正在启动本地服务器：${URL}"

# 用「两级 fork + setsid」把服务器彻底脱离终端：
# 关掉这个终端窗口、或启动它的进程退出，都不会把服务器一起带走。
NO_OPEN=1 python3 - "$PORT" "$DIR" "$LOGFILE" "$PIDFILE" <<'PY'
import os, sys
port, root, log, pidfile = sys.argv[1:5]
if os.fork() > 0:
    sys.exit(0)                     # 第一代父进程退出
os.setsid()                         # 新会话，脱离控制终端
if os.fork() > 0:
    os._exit(0)                     # 第二代退出，真正的服务器被 init 收养
os.chdir(root)
fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
os.dup2(fd, 1)
os.dup2(fd, 2)
os.dup2(os.open(os.devnull, os.O_RDONLY), 0)
with open(pidfile, "w") as f:
    f.write(str(os.getpid()) + "\n")
os.execvp("python3", ["python3", "serve.py", port])
PY

# 等端口真正就绪再开浏览器（最多 18 秒）
for _ in $(seq 1 90); do
  if listening; then
    echo "✅ 已启动（PID $(cat "$PIDFILE" 2>/dev/null)）"
    echo "   地址：${URL}"
    echo "   日志：${LOGFILE}"
    open "$URL"
    echo "   停止：双击 stop.command，或执行 ${DIR}/stop.command ${PORT}"
    exit 0
  fi
  sleep 0.2
done

echo "❌ 启动失败：18 秒内没能监听 ${PORT}。最后 20 行日志："
tail -n 20 "$LOGFILE" 2>/dev/null
rm -f "$PIDFILE"
exit 1
