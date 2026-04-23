#!/bin/bash
# 遇到错误即退出
set -e

echo "🚀 [1/4] 正在初始化系统通信总线 (DBus)..."
# 创建 dbus 目录并清理残留 pid (防止容器热重启卡死)
mkdir -p /var/run/dbus
rm -f /var/run/dbus/pid
# 在后台启动 dbus 守护进程
dbus-daemon --system --fork
sleep 2

echo "🚀 [2/4] 正在启动底层 WARP 守护进程..."
# 启动 warp-svc 并在后台运行
warp-svc > /tmp/warp-svc.log 2>&1 &
# 多给一点时间让守护进程完全就绪
sleep 5

echo "🌐 [3/4] 正在注册并配置 WARP 代理模式..."
# 注册新的 WARP 免费账户（|| true 允许已注册情况下的失败）
warp-cli --accept-tos registration new || true

# 设置为纯代理模式 (仅限本地连接，防滥用)
warp-cli --accept-tos mode proxy

# 设置 Socks5 代理端口为 40000
warp-cli --accept-tos proxy port 40000

# 连接 WARP 骨干网
warp-cli --accept-tos connect

sleep 3
echo "✅ WARP IPv6 穿透通道建立成功 (127.0.0.1:40000)！"

echo "⚡ [4/4] 正在启动 Server Monitor Pro Max (Telegram 不死鸟版)..."
# 启动 Node.js 面板，移交进程控制权
exec npm start
