# 使用 Debian 12 (Bookworm) Slim 版本作为基础，兼容 WARP 官方包
FROM node:20-bookworm-slim

# 设置工作目录
WORKDIR /app

# ⚠️ 核心新增：安装 dbus，这是 WARP 守护进程必须的底层组件
RUN apt-get update && apt-get install -y \
    python3 make g++ openssh-client curl gnupg lsb-release dbus \
    && rm -rf /var/lib/apt/lists/*

# 添加 Cloudflare 官方 WARP 软件源并安装 warp-cli
RUN curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg | gpg --yes --dearmor --output /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ $(lsb_release -cs) main" | tee /etc/apt/sources.list.d/cloudflare-client.list \
    && apt-get update \
    && apt-get install -y cloudflare-warp \
    && rm -rf /var/lib/apt/lists/*

# 拷贝 Node 项目依赖配置并安装
COPY package*.json ./
RUN npm install

# 拷贝所有代码文件和启动脚本
COPY . .

# 赋予启动脚本执行权限
RUN chmod +x /app/entrypoint.sh

# 暴露数据持久化目录和 Web 端口
VOLUME ["/app/data"]
EXPOSE 3000

# 强制使用 entrypoint 脚本作为容器的主入口
ENTRYPOINT ["/app/entrypoint.sh"]
