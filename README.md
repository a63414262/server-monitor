````markdown
# ⚡ Server Monitor Pro (Node.js 容器版)

[![Build and Push Docker Image](https://github.com/你的用户名/server-monitor/actions/workflows/docker.yml/badge.svg)](https://github.com/你的用户名/server-monitor/actions)
![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)
![Docker](https://img.shields.io/badge/Docker-Latest-blue.svg)
![License](https://img.shields.io/badge/License-MIT-yellow.svg)

**Server Monitor Pro** 是一款极其轻量、美观且易于部署的服务器监控系统。本项目专为 Claw Cloud (Sealos)、Docker 等容器化环境设计，采用 Node.js 后端 + SQLite3 持久化存储，支持 Telegram 离线告警、5 套美观主题自定义。

> **背景：** 本版本由原 Cloudflare Worker 版本重构而来，解决了容器环境下数据持久化、Node.js 运行时适配以及登录验证等核心问题。

---

## ✨ 核心特性

* 🚀 **极简部署**：完美适配 Claw Cloud / Sealos 容器平台，支持一键 Docker 部署。
* 🎨 **炫酷主题**：内置 5 套主题样式（经典、暗黑、粗野主义、毛玻璃、赛博朋克），支持自定义背景图。
* 📊 **实时图表**：基于 Chart.js 实时展示 CPU、内存、磁盘、流量及网络速度。
* ✈️ **TG 离线告警**：节点掉线超过 2 分钟，自动触发 Telegram Bot 推送通知。
* 💾 **数据持久化**：使用 SQLite 配合挂载卷，确保重启或更新镜像后配置不丢失。
* 🔒 **安全访问**：后台及私有模式通过 HTTP Basic Auth 保护。

---

## 🛠️ 技术栈

* **Backend**: Node.js, Express
* **Database**: SQLite3 (better-sqlite3)
* **Frontend**: HTML5, Vanilla JS, Chart.js
* **CI/CD**: GitHub Actions (Auto Docker Build)

---

## 🚀 快速开始

### 方式一：在 Claw Cloud (Sealos) 部署 (推荐)

1.  **准备存储**：在 `Local Storage` 中创建一个 `1Gi` 的存储卷，挂载路径设为 `/app/data`。
2.  **设置镜像**：
    * Image: `ghcr.io/你的用户名/server-monitor:latest`
    * Container Port: `3000`
3.  **配置环境变量**：
    * `PORT=3000`
    * `API_SECRET=你的复杂密码`
    * `DB_PATH=/app/data/monitor.db`
4.  **开启外网访问**：部署成功后，通过分配的域名访问即可。

### 方式二：手动 Docker 部署

```bash
docker run -d \
  --name server-monitor \
  -p 3000:3000 \
  -v /opt/monitor/data:/app/data \
  -e API_SECRET=admin123 \
  ghcr.io/你的用户名/server-monitor:latest
````

-----

## ⚙️ 环境变量说明

| 变量名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `PORT` | `3000` | 容器监听端口 |
| `API_SECRET` | `admin123` | 后台管理密码 (用户名固定为 admin) |
| `DB_PATH` | `/app/data/monitor.db` | SQLite 数据库保存路径 |

-----

## 📡 Agent 安装方法

1.  登录你的探针后台：`https://你的域名/admin`。
2.  点击 **"添加新服务器"**。
3.  在生成的节点列表中，点击 **"复制命令"**。
4.  在被控 VPS 上以 root 权限执行该命令即可。

**安装命令示例：**

```bash
curl -sL [https://your-domain.com/install.sh](https://your-domain.com/install.sh) | bash -s [ID] [SECRET]
```

-----

## 📝 常见问题 (FAQ)

  * **为什么点击后台报错 500？**
      * 请确保在 `server.js` 中将 `WWW-Authenticate` 的提示语修改为纯英文（如 "Admin Area"），避免中文字符导致 Header 编码错误。
  * **如何修改默认配置？**
      * 登录后台后点击“保存全局设置”，所有更改将实时写入数据库并持久化。

-----

## 🤝 鸣谢

  * 项目原型参考：[CF-Server-Monitor-Pro](https://github.com/a63414262/CF-Server-Monitor-Pro)
  * UI 设计参考：小K分享

## 📄 开源协议

本项目遵循 [MIT License](https://www.google.com/search?q=LICENSE)。

```

---

### 使用建议：
1.  **替换链接**：记得把上面 `你的用户名` 换成你真实的 GitHub ID。
2.  **License 文件**：如果你想更规范，可以在仓库根目录新建一个 `LICENSE` 文件，内容使用标准的 MIT 协议。
3.  **图片展示**：建议你手动截几张大盘的图，在 README 里加上 `![Screenshot](./screenshot.png)`，这样看起去会更专业。
