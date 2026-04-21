#!/bin/bash
echo "=========================================="
echo "🚀 初始化环境：V4 to V6 WARP 代理桥接模式"
echo "=========================================="

# 初始化 WARP 目录
mkdir -p /var/lib/cloudflare-warp

# 后台静默启动 WARP 守护进程
/usr/bin/warp-svc > /dev/null 2>&1 &
echo "⏳ 等待 WARP 服务启动..."
sleep 3

# 注册并设置为本地 SOCKS5 代理模式 (端口 40000)
echo "🔐 注册 WARP 终端并开启本地代理..."
warp-cli --accept-tos registration new
warp-cli --accept-tos mode proxy
warp-cli --accept-tos connect

sleep 3
# 打印状态确认连接成功
warp-cli --accept-tos status

echo "⚡ 启动 Server Monitor Pro 主控程序..."
exec npm start
