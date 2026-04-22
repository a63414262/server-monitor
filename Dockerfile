FROM node:20-bookworm

# 安装基础依赖并引入 Cloudflare 官方源安装 WARP，新增 openssh-client
RUN apt-get update && apt-get install -y curl gnupg lsb-release iproute2 openssh-client \
    && curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg | gpg --yes --dearmor --output /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ $(lsb_release -cs) main" | tee /etc/apt/sources.list.d/cloudflare-client.list \
    && apt-get update && apt-get install -y cloudflare-warp \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# 设置工作目录
WORKDIR /app

# 复制依赖并安装
COPY package*.json ./
RUN npm install

# 复制全部代码
COPY . .

# 赋予入口脚本执行权限
RUN chmod +x entrypoint.sh

EXPOSE 3000

# 启动容器时执行的入口点
ENTRYPOINT ["/app/entrypoint.sh"]
