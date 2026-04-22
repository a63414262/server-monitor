#!/bin/bash
set -e

echo "🚀 [1/3] 正在启动底层 WARP 守护进程..."
# 启动 warp-svc 并在后台运行
warp-svc > /dev/null 2>&1 &
# 给守护进程一点时间启动
sleep 3

echo "🌐 [2/3] 正在注册并配置 WARP 代理模式..."
# 注册新的 WARP 免费账户（自动接受用户协议）
warp-cli --accept-tos registration new || true

# 设置为纯代理模式 (这样它不会接管全局网络，只会监听本地端口)
warp-cli --accept-tos mode proxy

# 设置 Socks5 代理端口为 40000
warp-cli --accept-tos proxy port 40000

# 连接 WARP 网络
warp-cli --accept-tos connect

# 等待网络建立
sleep 3
echo "✅ WARP IPv6 穿透通道建立成功 (127.0.0.1:40000)！"

echo "⚡ [3/3] 正在启动 Server Monitor Pro Max 面板..."
# 启动 Node.js 项目，使用 exec 替换当前 shell 进程，确保信号正确传递
exec npm start
