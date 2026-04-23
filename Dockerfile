# 使用 Debian 12 (Bookworm) Slim 版本，完美兼容 WARP 和 Node.js
FROM node:20-bookworm-slim

# 设置工作目录
WORKDIR /app

# 安装 dbus (WARP守护进程必需) 以及其他网络和编译基础工具
RUN apt-get update && apt-get install -y \
    python3 make g++ openssh-client curl gnupg lsb-release dbus \
    && rm -rf /var/lib/apt/lists/*

# 添加 Cloudflare 官方 WARP 软件源并安装
RUN curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg | gpg --yes --dearmor --output /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ $(lsb_release -cs) main" | tee /etc/apt/sources.list.d/cloudflare-client.list \
    && apt-get update \
    && apt-get install -y cloudflare-warp \
    && rm -rf /var/lib/apt/lists/*

# 拷贝依赖配置并安装 (利用 Docker 缓存加速构建)
COPY package*.json ./
RUN npm install

# 拷贝剩余所有代码和脚本
COPY . .

# 赋予启动脚本执行权限
RUN chmod +x /app/entrypoint.sh

# 暴露 Web 服务端口 (无状态版本无需再强制挂载 VOLUME)
EXPOSE 3000

# 接管容器主入口
ENTRYPOINT ["/app/entrypoint.sh"]
