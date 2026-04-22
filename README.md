
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
- 🔒 **纯粹安全鉴权**：强制纯 GitHub OAuth 授权登录，杜绝后台被爆破风险。
- 🤖 **Telegram 离线告警**：节点超过 2 分钟无响应自动推送 TG 报警，恢复后自动发送恢复通知。
- 🎨 **极简个性化**：自带 5 款高颜值前端主题，支持自定义背景图和毛玻璃特效。
- 🧮 **附加黑科技**：自带 VPS 剩余价值计算器、支持探针端 IP 智能锁定防覆盖、原生防送中发包保活。

---

## 🔑 第一步：创建 GitHub OAuth 凭证 (用于后台登录)

由于面板采用了极其安全的 GitHub 授权登录，在部署前，你需要先去 GitHub 申请一组应用凭证。

1. 登录 GitHub，点击右上角头像，进入 **Settings (设置)**。
2. 滚动到左侧导航栏最底部，点击 **Developer settings (开发者设置)**。
3. 在左侧选择 **OAuth Apps**，点击右上角 **New OAuth App**。
4. 按以下规则填写信息：
   - **Application name**: `Server Monitor Pro` (或者你喜欢的名字)
   - **Homepage URL**: `https://Claw 分配给你的网址` (Claw 分配给你的网址)
   - **Authorization callback URL** (⚠️ 最关键的一步): 
     填写你未来面板的完整回调地址，例如：`https://Claw 分配给你的网址/auth/github/callback` (填 Claw 分配给你的网址加上 `/auth/github/callback`)。
5. 点击 **Register application**。
6. 在新页面中，你会看到 **Client ID**，请先复制保存。
7. 点击 **Generate a new client secret**，生成一串密钥。**立即复制保存它** (离开页面后将无法再次查看全文)。

---


## 🚀 第二步：Claw 容器平台一键部署

登录你的 Claw Cloud 控制台，进入 **App Launchpad**，按照以下详细步骤填写部署表单：

### 1. 基础配置
* **Application Name (应用名称)**: 随意填写，例如 `server-monitor`。
* **Image (镜像类型)**: 选择 **Public**。
* **Image Name (镜像名称)**: 填入GitHub 镜像地址， `ghcr.io/a63414262/repo:latest`。

### 2. 网络配置 (NodePorts)
* 在端口映射区域，**内部容器端口 (Container Port)** 必须填写：`3000`。
* public Access 必须打开获取网址。

### 3. 用量限制 (Usage)
* **Replicas (副本数)**: 保持默认 `1` 即可。CPU 和内存给默认基础配置完全够用。

### 4. 环境变量 (Environment Variables) ⚠️ 核心
点击 `+ Add Variable` 依次添加以下 4 个环境变量：
* `PORT` = `3000` 
* `API_SECRET` = `你自定义的探针通信秘钥` (例如 `MySecret123456`)
* `GITHUB_CLIENT_ID` = `第一步获取的 Client ID`
* `GITHUB_CLIENT_SECRET` = `第一步获取的 Client Secret`
* `GITHUB_ALLOWED_USERS` = `你的GitHub用户名` (防止陌生人授权进入，如有多个管理员用逗号分隔)

PORT=3000
API_SECRET=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_ALLOWED_USERS=
ENABLE_WEB_SSH=


### 5. 持久化存储 (Storage / Volumes) ⚠️ 极其重要
* 添加一个存储卷。
* **Mount Path (容器内挂载路径)** 必须精准填写：`/app/data`
> 如果不配置此项，每次容器重启或更新时，你的所有节点数据、探针记录以及主控端 SSH 密钥将彻底丢失！

**配置确认无误后，点击 Deploy (部署)。**
等待容器状态变为 Running 后，访问你配置的域名，点击登录，授权 GitHub 即可进入后台！

---

## 📡 探针端安装与卸载

### 安装探针
1. 登录面板后台，进入 **控制台**。
2. 输入新的节点名称，点击 **[+ 添加新服务器]**。
3. 复制列表中生成的专属一键安装命令。
4. 登录你的目标 VPS（被控机）终端，粘贴并执行即可。
*(支持纯 IPv4、纯 IPv6 及双栈网络。纯 IPv6 机器请确保面板域名已套入 Cloudflare 橙朵 CDN)*

### 卸载探针
如果需要彻底清理被控机上的探针、定时任务及免密公钥，请在被控机执行以下一键清理命令：
```bash
systemctl stop cf-probe.service && systemctl disable cf-probe.service && rm -f /etc/systemd/system/cf-probe.service && systemctl daemon-reload && rm -f /usr/local/bin/cf-probe.sh /usr/local/bin/cf-ip-check.sh /usr/local/bin/cf-ip-warm.sh && crontab -l 2>/dev/null | grep -v "cf-ip" | crontab - && sed -i '/Server-Monitor-Pro-Master/d' ~/.ssh/authorized_keys
````

-----

## 🤝 鸣谢与声明

  * 感谢 `express`、`better-sqlite3`、`ssh2`、`socks`、`chart.js` 等优秀开源组件。
  * 感谢 Cloudflare WARP 提供的强力网络穿透能力。

*本项目仅供学习与服务器资产管理交流使用。*

## 📜 许可证

[MIT License](https://www.google.com/search?q=./LICENSE)

```
```
