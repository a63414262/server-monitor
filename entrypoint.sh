#!/bin/bash

echo "🚀 初始化 Cloudflare Zero Trust 隐形网络..."

# 修复：必须使用标准的 plist XML 格式，否则 warp-svc 无法读取！
mkdir -p /var/lib/cloudflare-warp
cat << EOF > /var/lib/cloudflare-warp/mdm.xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>organization</key>
  <string>${CF_TEAM_NAME}</string>
  <key>auth_client_id</key>
  <string>${CF_CLIENT_ID}</string>
  <key>auth_client_secret</key>
  <string>${CF_CLIENT_SECRET}</string>
</dict>
</plist>
EOF

# 启动 WARP 后台服务并静默注册
/usr/bin/warp-svc > /dev/null 2>&1 &
sleep 5
warp-cli --accept-tos connect

echo "⚡ 正在启动 Server Monitor Pro 核心服务..."
exec npm start
