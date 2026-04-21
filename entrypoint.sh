#!/bin/bash

echo "🚀 初始化 Cloudflare Zero Trust 隐形网络..."

# 写入 MDM 自动化注册文件
mkdir -p /var/lib/cloudflare-warp
cat << EOF > /var/lib/cloudflare-warp/mdm.xml
<dict>
  <key>organization</key>
  <string>${CF_TEAM_NAME}</string>
  <key>auth_client_id</key>
  <string>${CF_CLIENT_ID}</string>
  <key>auth_client_secret</key>
  <string>${CF_CLIENT_SECRET}</string>
</dict>
EOF

# 启动 WARP 后台服务并静默注册
/usr/bin/warp-svc > /dev/null 2>&1 &
sleep 3
warp-cli --accept-tos registration new
warp-cli --accept-tos mode warp
warp-cli --accept-tos connect

echo "⚡ 正在启动 Server Monitor Pro 核心服务..."
exec npm start
