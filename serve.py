#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
诗境·山河 —— 本地开发服务器

用法：
    python3 serve.py            # 默认 http://127.0.0.1:8777
    python3 serve.py 8080       # 指定端口

说明：ES Module 必须通过 http(s) 协议加载，直接双击 index.html（file://）浏览器会
因跨域策略拒绝执行模块脚本。本脚本额外发送 no-store 头，避免开发时改代码不生效。
"""
import http.server
import socketserver
import sys
import os
import webbrowser
import threading

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8777
ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # 静默日志


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == '__main__':
    url = 'http://127.0.0.1:%d/index.html' % PORT
    with Server(('127.0.0.1', PORT), Handler) as httpd:
        print('诗境·山河 已启动：%s' % url)
        print('按 Ctrl+C 停止')
        if os.environ.get('NO_OPEN') != '1':
            threading.Timer(0.6, lambda: webbrowser.open(url)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\n已停止')
