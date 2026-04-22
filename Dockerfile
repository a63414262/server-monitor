FROM node:20-bookworm

# 修复依赖：增加 openssh-client (用于生成密钥), dos2unix (修复脚本换行符), dbus (WARP 运行依赖)
RUN apt-get update && apt-get install -y curl gnupg lsb-release iproute2 openssh-client dos2unix dbus \
    && curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg | gpg --yes --dearmor --output /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ $(lsb_release -cs) main" | tee /etc/apt/sources.list.d/cloudflare-client.list \
    && apt-get update && apt-get install -y cloudflare-warp \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# 极其关键：将 Windows 的 CRLF 换行符强行转换为 Linux 的 LF，否则容器 100% 无法启动！
RUN dos2unix entrypoint.sh && chmod +x entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["/app/entrypoint.sh"]
