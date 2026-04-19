# 使用 Alpine Linux 的 Node.js 基础镜像，体积小
FROM node:18-alpine

# 安装编译 better-sqlite3 需要的基础依赖
RUN apk add --no-cache python3 make g++ sqlite

# 设置工作目录
WORKDIR /app

# 拷贝 package.json 并安装依赖
COPY package*.json ./
RUN npm install --production

# 拷贝核心代码
COPY server.js ./

# 暴露端口，供 Claw 平台路由
EXPOSE 3000

# 启动服务
CMD ["npm", "start"]
