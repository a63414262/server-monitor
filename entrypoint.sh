#!/bin/sh

echo "🚀 正在启动全自动 WARP IPv6 隐形隧道..."
# 后台静默启动 WARP 用户态 SOCKS5 代理，监听 40000 端口
warp-plus -b 127.0.0.1:40000 > /dev/null 2>&1 &

echo "⚡ 正在启动 Server Monitor Pro 核心服务..."
exec npm start
