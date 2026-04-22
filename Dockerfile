FROM node:20-alpine

# 安装 sqlite 编译依赖 和 ssh-keygen 所需的 openssh-client
RUN apk add --no-cache python3 make g++ openssh-client

WORKDIR /app

COPY package*.json ./
RUN npm install

# 拷贝你的 server.js 
COPY . .

# 暴露数据持久化目录 (存放 SQLite 和 ssh_keys)
VOLUME ["/app/data"]

EXPOSE 3000

CMD ["npm", "start"]
