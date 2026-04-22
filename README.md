
# ⚡ Server Monitor Pro Max (All-in-One WARP Edition)

![Node.js](https://img.shields.io/badge/Node.js-20.x-green.svg)
![Docker](https://img.shields.io/badge/Docker-Supported-blue.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)

一个专为极客打造的轻量级、高性能多节点服务器状态监控面板。自带 Web SSH 终端，并深度融合 **Cloudflare WARP**，彻底解决纯 IPv4 面板无法直连管理纯 IPv6 VPS 的痛点。

---

## ✨ 核心特性

- 🌐 **V4/V6 智能穿透**：容器内置 Cloudflare WARP 本地代理，后台一键 SSH 秒连纯 IPv6 小鸡，无视网络隔阂。
- 💻 **内置 Web SSH**：抛弃传统密码，主控端自动生成 OpenSSH 密钥对，探针安装时自动下发公钥，实现真正的免密安全直连。
- 📊 **多维数据大盘**：实时监控 CPU、内存、磁盘、上下行网速、TCP/UDP 连接数，并持久化记录过去 12 小时的国内三网延迟波动（不掉线、不断点）。
- 🔒 **纯粹安全鉴权**：支持 GitHub OAuth 授权登录与强密码 Basic Auth 双重保护机制。
- 🤖 **Telegram 离线告警**：节点超过 2 分钟无响应自动推送 TG 报警，恢复后自动发送恢复通知。
- 🎨 **极简个性化**：自带 5 款高颜值前端主题（清爽白、暗黑、新粗野主义、动态渐变、赛博朋克），支持自定义背景图和毛玻璃特效。
- 🧮 **附加黑科技**：自带 VPS 剩余价值计算器、支持探针端 IP 智能锁定防覆盖、原生防送中发包保活。

---

## 🚀 极速部署 (推荐 Docker)

本项目专为容器化环境（如 Claw App Launchpad、普通 VPS）设计，数据全部采用高性能 SQLite WAL 模式，无需额外部署任何数据库。

### 方式一：Docker CLI 一键运行

```bash
docker run -d \
  --name server-monitor \
  --restart always \
  -p 3000:3000 \
  -v $(pwd)/data:/app/data \
  -e API_SECRET="你的超强后台密码" \
  ghcr.io/你的GitHub用户名/你的仓库名:latest
````

### 方式二：Docker Compose

创建一个 `docker-compose.yml` 文件：

```yaml
version: '3.8'
services:
  monitor:
    image: ghcr.io/你的GitHub用户名/你的仓库名:latest
    container_name: server-monitor
    restart: always
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
    environment:
      - API_SECRET=admin123456
      # 可选：配置 GitHub 授权登录 (留空则默认使用 API_SECRET 登录)
      # - GITHUB_CLIENT_ID=your_client_id
      # - GITHUB_CLIENT_SECRET=your_client_secret
      # - GITHUB_ALLOWED_USERS=your_github_username
```

然后执行：`docker-compose up -d`

-----

## ⚙️ 环境变量说明

| 变量名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `PORT` | `3000` | 容器内部监听端口 |
| `API_SECRET` | `admin123` | **(必填)** 探针通信秘钥与后台默认登录密码 |
| `GITHUB_CLIENT_ID` | 无 | (可选) GitHub OAuth App Client ID |
| `GITHUB_CLIENT_SECRET`| 无 | (可选) GitHub OAuth App Secret |
| `GITHUB_ALLOWED_USERS`| 无 | (可选) 允许登录的 GitHub 用户名白名单，用逗号分隔 |
| `DB_PATH` | `/app/data/monitor.db`| SQLite 数据库及 SSH 密钥存放路径 (强烈建议映射至宿主机) |

-----

## 📡 探针端安装

1.  登录面板后台 (`http://你的IP:3000/admin`)。
2.  输入新的节点名称，点击 **[+ 添加新服务器]**。
3.  复制生成的专属一键安装命令，在目标 VPS 的 SSH 终端中执行即可。

**探针卸载命令：**

```bash
systemctl stop cf-probe.service && systemctl disable cf-probe.service && rm -f /etc/systemd/system/cf-probe.service && systemctl daemon-reload && rm -f /usr/local/bin/cf-probe.sh /usr/local/bin/cf-ip-check.sh /usr/local/bin/cf-ip-warm.sh && crontab -l 2>/dev/null | grep -v "cf-ip" | crontab - && sed -i '/Server-Monitor-Pro-Master/d' ~/.ssh/authorized_keys
```

-----

## 📸 界面预览

*(提示：你可以在这里放两张项目的截图，比如前台大盘和后台管理界面的截图，格式为 `![大盘预览](./images/preview.png)`)*

-----

## 🤝 鸣谢与声明

  * 感谢 `express`、`better-sqlite3`、`ssh2`、`socks`、`chart.js` 等优秀开源组件。
  * 感谢 Cloudflare WARP 提供的强力网络穿透能力。

*本项目仅供学习与服务器资产管理交流使用。*

## 📜 许可证

[MIT License](https://www.google.com/search?q=./LICENSE)

```
```
