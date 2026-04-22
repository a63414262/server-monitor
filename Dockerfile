FROM node:20-alpine

# 安装 sqlite 编译依赖 和 ssh 密钥生成工具
RUN apk add --no-cache python3 make g++ openssh-client

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# 暴露数据持久化目录
VOLUME ["/app/data"]
EXPOSE 3000

CMD ["npm", "start"]
