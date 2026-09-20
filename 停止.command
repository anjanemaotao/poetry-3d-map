#!/bin/bash
# 诗境 · 山河 —— 停止后端服务（双击本文件即可）
#
# 这是中文名入口，逻辑全部在 stop.command 里（先按 pid 文件停，再用端口兜底 ——
# 手敲 python3 serve.py 起的进程也能停掉）。这里只做转调，不复制一份逻辑。
#
# 命令行用法：
#   ./停止.command          默认 8777 端口
#   ./停止.command 8080     换端口

DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/stop.command" "$@"
