#!/bin/bash
echo "=========================================="
echo "🚀 初始化环境：V4 to V6 WARP 代理桥接模式"
echo "=========================================="

# 修复 WARP 在容器内运行的环境依赖
mkdir -p /var/lib/cloudflare-warp
mkdir -p /run/dbus

# 后台静默启动 WARP 守护进程 (重定向错误日志防止卡死)
/usr/bin/warp-svc > /tmp/warp.log 2>&1 &
echo "⏳ 等待 WARP 服务启动..."
sleep 4

# 尝试注册并设置为本地 SOCKS5 代理模式
# 注意这里加了 || true，意思是就算 WARP 在这种云容器里没权限报错，也绝不阻断后续面板的启动！
echo "🔐 尝试注册 WARP 终端并开启本地代理..."
warp-cli --accept-tos registration new || echo "⚠️ WARP 注册受阻，可能是容器权限不足"
warp-cli --accept-tos mode proxy || true
warp-cli --accept-tos connect || true

sleep 2
warp-cli --accept-tos status || true

echo "=========================================="
echo "⚡ 开始启动 Server Monitor Pro 主程序..."
echo "=========================================="
exec npm start
