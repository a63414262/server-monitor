import express from 'express';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(express.json({ limit: '10mb' }));

// ==========================================
// 容器环境变量配置
// ==========================================
const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || 'admin123';
const DB_PATH = process.env.DB_PATH || '/app/data/monitor.db';

// 初始化数据库目录 (确保挂载的 /app/data 目录存在)
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

// 初始化 SQLite (开启 WAL 模式提升并发性能)
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY, name TEXT, cpu TEXT, ram TEXT, disk TEXT, load_avg TEXT,
    uptime TEXT, last_updated INTEGER, ram_total TEXT, net_rx TEXT, net_tx TEXT,
    net_in_speed TEXT, net_out_speed TEXT, os TEXT, cpu_info TEXT, country TEXT,
    server_group TEXT, price TEXT, expire_date TEXT, bandwidth TEXT, traffic_limit TEXT,
    ip_v4 TEXT, ip_v6 TEXT, arch TEXT, boot_time TEXT, ram_used TEXT, swap_total TEXT,
    swap_used TEXT, disk_total TEXT, disk_used TEXT, processes TEXT, tcp_conn TEXT, udp_conn TEXT
  );
`);

// ==========================================
// 工具函数与全局配置
// ==========================================
const formatBytes = (bytes) => {
    const b = parseInt(bytes);
    if (isNaN(b) || b === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(b) / Math.log(k));
    return parseFloat((b / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const getSysSettings = () => {
    let sys = {
        site_title: '⚡ Server Monitor Pro',
        admin_title: '⚙️ 探针管理后台',
        theme: 'theme1', 
        custom_bg: '',
        is_public: 'true',
        show_price: 'true',
        show_expire: 'true',
        show_bw: 'true',
        show_tf: 'true',
        tg_notify: 'false',
        tg_bot_token: '',
        tg_chat_id: ''
    };
    try {
        const results = db.prepare('SELECT * FROM settings').all();
        results.forEach(r => sys[r.key] = r.value);
    } catch (e) {}
    return sys;
};

const checkAuth = (req) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return false;
    const [scheme, encoded] = authHeader.split(' ');
    if (scheme !== 'Basic' || !encoded) return false;
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
    const [username, password] = decoded.split(':');
    return username === 'admin' && password === API_SECRET;
};

const requireAuth = (req, res, next) => {
    const sys = getSysSettings();
    if (!checkAuth(req)) {
        res.setHeader('WWW-Authenticate', `Basic realm="${sys.admin_title}"`);
        return res.status(401).send('Unauthorized');
    }
    next();
};

// ==========================================
// Telegram 离线通知
// ==========================================
const sendTelegram = async (sys, msg) => {
    if (sys.tg_notify !== 'true' || !sys.tg_bot_token || !sys.tg_chat_id) return;
    try {
        await fetch(`https://api.telegram.org/bot${sys.tg_bot_token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: sys.tg_chat_id, text: msg, parse_mode: 'HTML' })
        });
    } catch (e) {}
};

const checkOfflineNodes = async () => {
    const sys = getSysSettings();
    if (sys.tg_notify !== 'true') return;
    try {
        const allServers = db.prepare('SELECT id, name, last_updated FROM servers').all();
        let alertState = {};
        const stateRes = db.prepare("SELECT value FROM settings WHERE key = 'alert_state'").get();
        if (stateRes) alertState = JSON.parse(stateRes.value);

        let stateChanged = false;
        const now = Date.now();

        for (const s of allServers) {
            const diff = now - s.last_updated;
            const isOffline = diff > 120000;

            if (isOffline && !alertState[s.id]) {
                await sendTelegram(sys, `⚠️ <b>节点离线告警</b>\n\n<b>节点名称:</b> ${s.name}\n<b>状态:</b> 离线 (超过2分钟未上报)\n<b>时间:</b> ${new Date().toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'})}`);
                alertState[s.id] = true;
                stateChanged = true;
            } else if (!isOffline && alertState[s.id]) {
                await sendTelegram(sys, `✅ <b>节点恢复通知</b>\n\n<b>节点名称:</b> ${s.name}\n<b>状态:</b> 恢复在线\n<b>时间:</b> ${new Date().toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'})}`);
                delete alertState[s.id];
                stateChanged = true;
            }
        }

        if (stateChanged) {
            db.prepare('INSERT INTO settings (key, value) VALUES ("alert_state", ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(JSON.stringify(alertState));
        }
    } catch (e) {}
};

// ==========================================
// 前端 UI 样式组件
// ==========================================
const getThemeStyles = (sys) => `
    body.theme2 { background-color: #0d1117; color: #c9d1d9; }
    .theme2 .vps-card, .theme2 .global-stats, .theme2 .header-card, .theme2 .chart-card { background: #161b22; color: #c9d1d9; box-shadow: 0 4px 6px rgba(0,0,0,0.4); border: 1px solid #30363d; }
    .theme2 .vps-card:hover { border-color: #8b949e; }
    .theme2 .group-header { color: #58a6ff; border-left-color: #58a6ff; }
    .theme2 .stat-val, .theme2 .g-val { color: #fff; }
    .theme2 .stat-label, .theme2 .g-label, .theme2 .g-sub, .theme2 .card-meta { color: #8b949e; }
    .theme2 .stat-bar { background: #21262d; }
    .theme2 .divider { background: #30363d; }
    .theme2 .card-title { color: #fff; }

    body.theme3 { background-color: #fef08a; color: #000; font-weight: 500; }
    .theme3 .vps-card, .theme3 .global-stats, .theme3 .header-card, .theme3 .chart-card { background: #fff; border: 3px solid #000; border-radius: 0; box-shadow: 6px 6px 0px #000; transition: transform 0.1s, box-shadow 0.1s; }
    .theme3 .vps-card:hover { transform: translate(2px, 2px); box-shadow: 4px 4px 0px #000; border-color: #000; }
    .theme3 .group-header { color: #000; border-left: none; border-bottom: 4px solid #000; padding-left: 0; display: inline-block; font-size: 22px; font-weight: 900; text-transform: uppercase; }
    .theme3 .stat-bar { background: #e5e5e5; border: 1px solid #000; }
    .theme3 .stat-bar > div { border-right: 1px solid #000; }
    .theme3 .badge { border: 1px solid #000; border-radius: 0; }
    .theme3 .stat-val, .theme3 .g-val, .theme3 .card-title { font-weight: 900; color: #000; }

    body.theme4 { background: linear-gradient(45deg, #4facfe 0%, #00f2fe 100%); background-attachment: fixed; color: #fff; }
    .theme4 .vps-card, .theme4 .global-stats, .theme4 .header-card, .theme4 .chart-card { background: rgba(255, 255, 255, 0.2); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid rgba(255, 255, 255, 0.4); box-shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.1); color: #fff; }
    .theme4 .vps-card:hover { background: rgba(255, 255, 255, 0.3); border-color: rgba(255, 255, 255, 0.8); }
    .theme4 .group-header { color: #fff; border-left-color: #fff; text-shadow: 0 2px 4px rgba(0,0,0,0.2); }
    .theme4 .stat-val, .theme4 .g-val, .theme4 .card-title { color: #fff; }
    .theme4 .stat-label, .theme4 .g-label, .theme4 .g-sub, .theme4 .card-meta { color: rgba(255,255,255,0.8); }
    .theme4 .stat-bar { background: rgba(0,0,0,0.2); }
    .theme4 .divider { background: rgba(255,255,255,0.2); }

    body.theme5 { background-color: #050505; color: #0ff; font-family: 'Courier New', Courier, monospace; }
    .theme5 .vps-card, .theme5 .global-stats, .theme5 .header-card, .theme5 .chart-card { background: #0b0c10; border: 1px solid #f0f; border-radius: 0; box-shadow: 0 0 10px rgba(255, 0, 255, 0.2); color: #fff; }
    .theme5 .vps-card:hover { box-shadow: 0 0 20px rgba(0, 255, 255, 0.5); border-color: #0ff; }
    .theme5 .group-header { color: #f0f; border-left: 5px solid #0ff; text-shadow: 0 0 5px #f0f; }
    .theme5 .stat-val, .theme5 .g-val, .theme5 .card-title { color: #0ff; text-shadow: 0 0 5px #0ff; }
    .theme5 .stat-label, .theme5 .g-label, .theme5 .g-sub, .theme5 .card-meta { color: #f0f; }
    .theme5 .stat-bar { background: #222; }
    .theme5 .stat-bar > div { background: #0ff !important; box-shadow: 0 0 10px #0ff; }
    .theme5 .divider { background: #333; }
    .theme5 .badge-bw { background: #f0f; box-shadow: 0 0 5px #f0f; }
    .theme5 .badge-tf { background: #0ff; color:#000; box-shadow: 0 0 5px #0ff; }

    ${sys.custom_bg ? `
      body {
        background: url('${sys.custom_bg}') no-repeat center center fixed !important;
        background-size: cover !important;
      }
      .vps-card, .global-stats, .header-card, .chart-card {
        background: rgba(255, 255, 255, 0.4) !important; 
        backdrop-filter: blur(12px) !important;
        -webkit-backdrop-filter: blur(12px) !important;
        border: 1px solid rgba(255, 255, 255, 0.6) !important;
        box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.1) !important;
        color: #111 !important;
      }
      .vps-card:hover { background: rgba(255, 255, 255, 0.6) !important; transform: translateY(-3px); }
      .group-header { color: #fff !important; text-shadow: 0 2px 5px rgba(0,0,0,0.6) !important; border-left-color: #fff !important; }
      .stat-val, .g-val, .card-title { color: #000 !important; font-weight: 800 !important; }
      .stat-label, .g-label, .g-sub, .card-meta { color: #333 !important; font-weight: 600 !important; }
      .stat-bar { background: rgba(0,0,0,0.1) !important; }
    ` : ''}
`;

const footerHtml = `
  <div style="text-align: center; margin-top: 40px; padding-bottom: 20px; font-size: 13px; color: inherit; opacity: 0.8;">
    Powered by CF-Server-Monitor-Pro | Node.js Edition
  </div>
`;

// ==========================================
// 路由控制器
// ==========================================

app.post('/admin/api', requireAuth, (req, res) => {
    try {
        const data = req.body;
        if (data.action === 'save_settings') {
            const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
            db.transaction(() => {
                for (const [k, v] of Object.entries(data.settings)) stmt.run(k, v);
            })();
            res.json({ success: true });
        } 
        else if (data.action === 'add') {
            const id = crypto.randomUUID();
            const name = data.name || 'New Server';
            db.prepare(`
                INSERT INTO servers 
                (id, name, cpu, ram, disk, load_avg, uptime, last_updated, ram_total, net_rx, net_tx, net_in_speed, net_out_speed, os, cpu_info, country, server_group, price, expire_date, bandwidth, traffic_limit, ip_v4, ip_v6) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(id, name, '0', '0', '0', '0', '0', 0, '0', '0', '0', '0', '0', '', '', '', '默认分组', '免费', '', '', '', '0', '0');
            res.json({ success: true });
        } 
        else if (data.action === 'delete') {
            db.prepare('DELETE FROM servers WHERE id = ?').run(data.id);
            res.json({ success: true });
        } 
        else if (data.action === 'edit') {
            db.prepare(`
                UPDATE servers SET server_group = ?, price = ?, expire_date = ?, bandwidth = ?, traffic_limit = ? WHERE id = ?
            `).run(data.server_group || '默认分组', data.price || '', data.expire_date || '', data.bandwidth || '', data.traffic_limit || '', data.id);
            res.json({ success: true });
        }
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.get('/admin', requireAuth, (req, res) => {
    const sys = getSysSettings();
    const results = db.prepare('SELECT id, name, last_updated, server_group, price, expire_date, bandwidth, traffic_limit FROM servers').all();
    const now = Date.now();
    const host = `${req.protocol}://${req.get('host')}`;
    
    let trs = '';
    if (results && results.length > 0) {
        for (const s of results) {
            const isOnline = (now - s.last_updated) < 30000;
            const status = isOnline ? '<span style="color:green; font-weight:bold;">在线</span>' : '<span style="color:red; font-weight:bold;">离线</span>';
            const cmd = `curl -sL ${host}/install.sh | bash -s ${s.id} ${API_SECRET}`;
            
            trs += `
                <tr>
                    <td>${s.name}</td>
                    <td>${s.server_group || '默认分组'}</td>
                    <td>${status}</td>
                    <td>
                        <input type="text" readonly value="${cmd}" style="width:280px; padding:6px; margin-right:5px; border:1px solid #ccc; border-radius:4px;" id="cmd-${s.id}">
                        <button onclick="copyCmd('${s.id}')" class="btn btn-green">复制命令</button>
                        <button onclick="openEditModal('${s.id}', '${s.server_group||''}', '${s.price||''}', '${s.expire_date||''}', '${s.bandwidth||''}', '${s.traffic_limit||''}')" class="btn btn-blue">✏️ 编辑</button>
                        <button onclick="deleteServer('${s.id}')" class="btn btn-red">🗑️ 删除</button>
                    </td>
                </tr>
            `;
        }
    }

    const html = `<!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>${sys.admin_title}</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 20px; background: #f0f2f5; color: #333;}
        .card { background: white; padding: 25px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); max-width: 1100px; margin: 0 auto 20px auto; }
        h2 { margin-top: 0; border-bottom: 2px solid #f0f2f5; padding-bottom: 10px; font-size: 20px;}
        table { width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 14px; }
        th, td { border: 1px solid #eee; padding: 12px; text-align: left; }
        th { background: #f8f9fa; }
        .btn { cursor: pointer; border-radius: 4px; font-size: 13px; transition: opacity 0.2s; border: none; padding: 6px 10px; color: white; margin-left: 5px; }
        .btn:hover { opacity: 0.8; }
        .btn-blue { background: #3b82f6; } .btn-green { background: #10b981; } .btn-red { background: #ef4444; } .btn-gray { background: #6b7280; }
        .settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px; }
        .form-group { display: flex; flex-direction: column; margin-bottom: 15px; }
        .form-group label { font-size: 14px; font-weight: 600; margin-bottom: 6px; color: #555;}
        .form-group input[type="text"], .form-group select { padding: 10px; border: 1px solid #ccc; border-radius: 6px; }
        .checkbox-group { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; font-size: 14px;}
        .checkbox-group input { width: 18px; height: 18px; cursor: pointer; }
        .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 100; }
        .modal-content { background: white; padding: 20px; border-radius: 8px; width: 400px; margin: 100px auto; position: relative;}
        .modal input { width: 100%; padding: 8px; margin-bottom: 12px; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box;}
        .modal label { font-size: 14px; color: #555; display: block; margin-bottom: 4px; font-weight: bold;}
      </style>
    </head>
    <body>
      <div class="card">
        <h2>🛠️ 全局设置</h2>
        <div class="settings-grid">
          <div>
            <div class="form-group">
              <label>🎨 前端主题风格 (5选1)</label>
              <select id="cfg_theme">
                <option value="theme1" ${sys.theme === 'theme1' ? 'selected' : ''}>1. 默认清爽白 (Classic White)</option>
                <option value="theme2" ${sys.theme === 'theme2' ? 'selected' : ''}>2. 暗黑极客 (Dark Mode)</option>
                <option value="theme3" ${sys.theme === 'theme3' ? 'selected' : ''}>3. 新粗野主义 (Brutalism)</option>
                <option value="theme4" ${sys.theme === 'theme4' ? 'selected' : ''}>4. 动态渐变毛玻璃 (Glassmorphism)</option>
                <option value="theme5" ${sys.theme === 'theme5' ? 'selected' : ''}>5. 赛博朋克 (Cyberpunk)</option>
              </select>
            </div>
            <div class="form-group">
              <label>🖼️ 自定义背景图片 (上传或填URL，开启后强制全透明)</label>
              <div style="display:flex; gap:8px;">
                 <input type="text" id="cfg_custom_bg" value="${sys.custom_bg || ''}" placeholder="粘贴图片 URL 或 点击右侧按钮上传" style="flex:1;">
                 <input type="file" id="bg_file" accept="image/*" style="display:none;" onchange="uploadBg(this)">
                 <button class="btn btn-gray" onclick="document.getElementById('bg_file').click()">📁 本地上传</button>
              </div>
              <img id="bg_preview" src="${sys.custom_bg || ''}" style="max-height: 120px; margin-top: 10px; border-radius: 6px; box-shadow: 0 2px 5px rgba(0,0,0,0.2); display: ${sys.custom_bg ? 'block' : 'none'}; object-fit: cover;">
            </div>
            <div class="form-group"><label>前台看板标题</label><input type="text" id="cfg_site_title" value="${sys.site_title}"></div>
            <div class="form-group"><label>后台标签栏名称</label><input type="text" id="cfg_admin_title" value="${sys.admin_title}"></div>
          </div>
          <div>
            <label style="font-size: 14px; font-weight: 600; margin-bottom: 10px; display: block; color: #555;">👁️ 前台展示控制</label>
            <div class="checkbox-group"><input type="checkbox" id="cfg_is_public" ${sys.is_public === 'true' ? 'checked' : ''}><label><b>公开访问</b> (取消勾选后必须输入密码)</label></div>
            <div class="checkbox-group"><input type="checkbox" id="cfg_show_price" ${sys.show_price === 'true' ? 'checked' : ''}><label>显示 <b>价格</b></label></div>
            <div class="checkbox-group"><input type="checkbox" id="cfg_show_expire" ${sys.show_expire === 'true' ? 'checked' : ''}><label>显示 <b>到期时间</b></label></div>
            <div class="checkbox-group"><input type="checkbox" id="cfg_show_bw" ${sys.show_bw === 'true' ? 'checked' : ''}><label>显示 <b>带宽徽章</b></label></div>
            <div class="checkbox-group"><input type="checkbox" id="cfg_show_tf" ${sys.show_tf === 'true' ? 'checked' : ''}><label>显示 <b>流量配额徽章</b></label></div>

            <hr style="margin: 20px 0; border: none; border-top: 1px dashed #ccc;">
            <label style="font-size: 14px; font-weight: 600; margin-bottom: 10px; display: block; color: #e63946;">✈️ Telegram 离线告警设置</label>
            <div class="form-group">
              <label>开启离线通知</label>
              <select id="cfg_tg_notify">
                <option value="false" ${sys.tg_notify !== 'true' ? 'selected' : ''}>关闭告警</option>
                <option value="true" ${sys.tg_notify === 'true' ? 'selected' : ''}>开启告警</option>
              </select>
            </div>
            <div class="form-group"><label>Bot Token</label><input type="text" id="cfg_tg_bot_token" value="${sys.tg_bot_token || ''}"></div>
            <div class="form-group"><label>Chat ID</label><input type="text" id="cfg_tg_chat_id" value="${sys.tg_chat_id || ''}"></div>
          </div>
        </div>
        <button onclick="saveSettings()" class="btn btn-blue" style="padding: 10px 20px; font-size: 15px;">💾 保存全局设置</button>
      </div>

      <div class="card">
        <h2>${sys.admin_title} - 节点列表</h2>
        <div style="margin-bottom: 15px;">
          <input type="text" id="newName" placeholder="输入新服务器名称" style="padding: 8px; width: 200px; border:1px solid #ccc; border-radius:4px;">
          <button onclick="addServer()" class="btn btn-blue" style="padding: 9px 15px;">+ 添加新服务器</button>
          <a href="/" style="float: right; margin-top: 8px; color: #3b82f6; text-decoration: none; font-weight:bold;">👉 前往大盘预览</a>
        </div>
        <table>
          <tr><th>节点名称</th><th>分组</th><th>在线状态</th><th>操作</th></tr>
          ${trs || '<tr><td colspan="4" style="text-align:center; padding: 30px; color:#666;">暂无服务器，请在上方添加</td></tr>'}
        </table>
      </div>

      <div id="editModal" class="modal">
        <div class="modal-content">
          <h3 style="margin-top:0;">✏️ 编辑服务器信息</h3>
          <input type="hidden" id="editId">
          <label>分组名称</label> <input type="text" id="editGroup" placeholder="如：美国 VPS">
          <label>价格</label> <input type="text" id="editPrice" placeholder="如：40USD/Year 或 免费">
          <label>到期时间</label> <input type="date" id="editExpire">
          <label>带宽 (前端徽章)</label> <input type="text" id="editBandwidth" placeholder="如：1Gbps 或 200Mbps">
          <label>流量总量 (前端徽章)</label> <input type="text" id="editTraffic" placeholder="如：1TB/月">
          <div style="text-align: right; margin-top: 10px;">
            <button onclick="closeModal()" style="padding: 8px 15px; border: 1px solid #ccc; background: white; margin-right: 5px; cursor:pointer;">取消</button>
            <button onclick="saveEdit()" class="btn btn-blue" style="padding: 8px 15px;">保存更改</button>
          </div>
        </div>
      </div>
      
      ${footerHtml}

      <script>
        function uploadBg(input) {
          const file = input.files[0];
          if(!file) return;
          const reader = new FileReader();
          reader.onload = function(e) {
            document.getElementById('cfg_custom_bg').value = e.target.result;
            document.getElementById('bg_preview').src = e.target.result;
            document.getElementById('bg_preview').style.display = 'block';
          };
          reader.readAsDataURL(file);
        }

        async function saveSettings() {
          const data = {
            action: 'save_settings',
            settings: {
              theme: document.getElementById('cfg_theme').value,
              custom_bg: document.getElementById('cfg_custom_bg').value,
              site_title: document.getElementById('cfg_site_title').value,
              admin_title: document.getElementById('cfg_admin_title').value,
              is_public: document.getElementById('cfg_is_public').checked ? 'true' : 'false',
              show_price: document.getElementById('cfg_show_price').checked ? 'true' : 'false',
              show_expire: document.getElementById('cfg_show_expire').checked ? 'true' : 'false',
              show_bw: document.getElementById('cfg_show_bw').checked ? 'true' : 'false',
              show_tf: document.getElementById('cfg_show_tf').checked ? 'true' : 'false',
              tg_notify: document.getElementById('cfg_tg_notify').value,
              tg_bot_token: document.getElementById('cfg_tg_bot_token').value,
              tg_chat_id: document.getElementById('cfg_tg_chat_id').value
            }
          };
          const res = await fetch('/admin/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
          if (res.ok) { alert('✅ 设置已保存！'); location.reload(); } else alert('保存失败');
        }
        async function addServer() {
          const name = document.getElementById('newName').value;
          if (!name) return alert('请输入名称');
          const res = await fetch('/admin/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'add', name }) });
          if (res.ok) location.reload(); else alert('添加失败');
        }
        async function deleteServer(id) {
          if (!confirm('确定要删除这个节点吗？')) return;
          const res = await fetch('/admin/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete', id }) });
          if (res.ok) location.reload(); else alert('删除失败');
        }
        function copyCmd(id) {
          const input = document.getElementById('cmd-' + id);
          input.select(); document.execCommand('copy');
          alert('✅ 一键命令已复制！');
        }
        function openEditModal(id, group, price, expire, bw, traffic) {
          document.getElementById('editId').value = id;
          document.getElementById('editGroup').value = group || '默认分组';
          document.getElementById('editPrice').value = price || '免费';
          document.getElementById('editExpire').value = expire || '';
          document.getElementById('editBandwidth').value = bw || '';
          document.getElementById('editTraffic').value = traffic || '';
          document.getElementById('editModal').style.display = 'block';
        }
        function closeModal() { document.getElementById('editModal').style.display = 'none'; }
        async function saveEdit() {
          const data = {
            action: 'edit', id: document.getElementById('editId').value,
            server_group: document.getElementById('editGroup').value, price: document.getElementById('editPrice').value,
            expire_date: document.getElementById('editExpire').value, bandwidth: document.getElementById('editBandwidth').value,
            traffic_limit: document.getElementById('editTraffic').value
          };
          const res = await fetch('/admin/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
          if (res.ok) location.reload(); else alert('保存失败');
        }
      </script>
    </body>
    </html>`;
    res.send(html);
});

app.get('/install.sh', (req, res) => {
    const host = `${req.protocol}://${req.get('host')}`;
    const bashScript = `#!/bin/bash
SERVER_ID=$1
SECRET=$2
WORKER_URL="${host}/update"

if [ -z "$SERVER_ID" ] || [ -z "$SECRET" ]; then echo "错误: 缺少参数。"; exit 1; fi
echo "开始安装探针 Agent..."

systemctl stop cf-probe.service 2>/dev/null
pkill -f cf-probe.sh 2>/dev/null

cat << 'EOF' > /usr/local/bin/cf-probe.sh
#!/bin/bash
SERVER_ID="$1"
SECRET="$2"
WORKER_URL="$3"

get_net_bytes() { awk 'NR>2 {rx+=$2; tx+=$10} END {printf "%.0f %.0f", rx, tx}' /proc/net/dev; }
get_cpu_stat() { awk '/^cpu / {print $2+$3+$4+$5+$6+$7+$8+$9, $5+$6}' /proc/stat; }

NET_STAT=$(get_net_bytes)
RX_PREV=$(echo $NET_STAT | awk '{print $1}')
TX_PREV=$(echo $NET_STAT | awk '{print $2}')
if [ -z "$RX_PREV" ]; then RX_PREV=0; fi
if [ -z "$TX_PREV" ]; then TX_PREV=0; fi

CPU_STAT=$(get_cpu_stat)
PREV_CPU_TOTAL=$(echo $CPU_STAT | awk '{print $1}')
PREV_CPU_IDLE=$(echo $CPU_STAT | awk '{print $2}')

LOOP_COUNT=0
IPV4="0"; IPV6="0"

while true; do
  if [ $((LOOP_COUNT % 60)) -eq 0 ]; then
    curl -s -4 -m 3 https://cloudflare.com/cdn-cgi/trace 2>/dev/null | grep -q "ip=" && IPV4="1" || IPV4="0"
    curl -s -6 -m 3 https://cloudflare.com/cdn-cgi/trace 2>/dev/null | grep -q "ip=" && IPV6="1" || IPV6="0"
  fi
  LOOP_COUNT=$((LOOP_COUNT + 1))

  OS=$(awk -F= '/^PRETTY_NAME/{print $2}' /etc/os-release | tr -d '"')
  if [ -z "$OS" ]; then OS=$(uname -srm); fi
  ARCH=$(uname -m)
  BOOT_TIME=$(uptime -s 2>/dev/null || stat -c %y / 2>/dev/null | cut -d'.' -f1 || echo "Unknown")
  CPU_INFO=$(grep -m 1 'model name' /proc/cpuinfo | awk -F: '{print $2}' | xargs | tr -d '"')
  
  CPU_STAT=$(get_cpu_stat)
  CPU_TOTAL=$(echo $CPU_STAT | awk '{print $1}')
  CPU_IDLE=$(echo $CPU_STAT | awk '{print $2}')
  DIFF_TOTAL=$((CPU_TOTAL - PREV_CPU_TOTAL))
  DIFF_IDLE=$((CPU_IDLE - PREV_CPU_IDLE))
  CPU=$(awk -v t=$DIFF_TOTAL -v i=$DIFF_IDLE 'BEGIN {if (t==0) print 0; else printf "%.2f", (1 - i/t)*100}')
  PREV_CPU_TOTAL=$CPU_TOTAL; PREV_CPU_IDLE=$CPU_IDLE
  
  MEM_INFO=$(free -m)
  RAM_TOTAL=$(echo "$MEM_INFO" | awk '/Mem:/ {print $2}')
  RAM_USED=$(echo "$MEM_INFO" | awk '/Mem:/ {print $3}')
  RAM=$(awk "BEGIN {if($RAM_TOTAL>0) printf \\"%.2f\\", $RAM_USED/$RAM_TOTAL * 100.0; else print 0}")
  
  SWAP_TOTAL=$(echo "$MEM_INFO" | awk '/Swap:/ {print $2}')
  SWAP_USED=$(echo "$MEM_INFO" | awk '/Swap:/ {print $3}')
  if [ -z "$SWAP_TOTAL" ]; then SWAP_TOTAL=0; fi
  if [ -z "$SWAP_USED" ]; then SWAP_USED=0; fi

  DISK_INFO=$(df -hm / | tail -n1 | awk '{print $2, $3, $5}')
  DISK_TOTAL=$(echo "$DISK_INFO" | awk '{print $1}')
  DISK_USED=$(echo "$DISK_INFO" | awk '{print $2}')
  DISK=$(echo "$DISK_INFO" | awk '{print $3}' | tr -d '%')

  LOAD=$(cat /proc/loadavg | awk '{print $1, $2, $3}')
  UPTIME=$(uptime -p | sed 's/up //')
  
  PROCESSES=$(ps -e | wc -l)
  TCP_CONN=$(ss -ant 2>/dev/null | grep -v State | wc -l || netstat -ant 2>/dev/null | grep -v Active | wc -l)
  UDP_CONN=$(ss -anu 2>/dev/null | grep -v State | wc -l || netstat -anu 2>/dev/null | grep -v Active | wc -l)
  
  NET_STAT=$(get_net_bytes)
  RX_NOW=$(echo $NET_STAT | awk '{print $1}')
  TX_NOW=$(echo $NET_STAT | awk '{print $2}')
  if [ -z "$RX_NOW" ]; then RX_NOW=0; fi
  if [ -z "$TX_NOW" ]; then TX_NOW=0; fi

  RX_SPEED=$(((RX_NOW - RX_PREV) / 5))
  TX_SPEED=$(((TX_NOW - TX_PREV) / 5))
  RX_PREV=$RX_NOW; TX_PREV=$TX_NOW
  
  PAYLOAD="{\\"id\\": \\"$SERVER_ID\\", \\"secret\\": \\"$SECRET\\", \\"metrics\\": { \\"cpu\\": \\"$CPU\\", \\"ram\\": \\"$RAM\\", \\"ram_total\\": \\"$RAM_TOTAL\\", \\"ram_used\\": \\"$RAM_USED\\", \\"swap_total\\": \\"$SWAP_TOTAL\\", \\"swap_used\\": \\"$SWAP_USED\\", \\"disk\\": \\"$DISK\\", \\"disk_total\\": \\"$DISK_TOTAL\\", \\"disk_used\\": \\"$DISK_USED\\", \\"load\\": \\"$LOAD\\", \\"uptime\\": \\"$UPTIME\\", \\"boot_time\\": \\"$BOOT_TIME\\", \\"net_rx\\": \\"$RX_NOW\\", \\"net_tx\\": \\"$TX_NOW\\", \\"net_in_speed\\": \\"$RX_SPEED\\", \\"net_out_speed\\": \\"$TX_SPEED\\", \\"os\\": \\"$OS\\", \\"arch\\": \\"$ARCH\\", \\"cpu_info\\": \\"$CPU_INFO\\", \\"processes\\": \\"$PROCESSES\\", \\"tcp_conn\\": \\"$TCP_CONN\\", \\"udp_conn\\": \\"$UDP_CONN\\", \\"ip_v4\\": \\"$IPV4\\", \\"ip_v6\\": \\"$IPV6\\" }}"
  
  curl -s -X POST -H "Content-Type: application/json" -d "$PAYLOAD" "$WORKER_URL" > /dev/null
  sleep 5
done
EOF

chmod +x /usr/local/bin/cf-probe.sh

cat << EOF > /etc/systemd/system/cf-probe.service
[Unit]
Description=Server Monitor Probe Agent
After=network.target

[Service]
ExecStart=/usr/local/bin/cf-probe.sh $SERVER_ID $SECRET $WORKER_URL
Restart=always
User=root

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable cf-probe.service
systemctl restart cf-probe.service

echo "✅ 探针安装成功！"
`;
    res.setHeader('Content-Type', 'text/plain;charset=UTF-8');
    res.send(bashScript);
});

app.post('/update', (req, res) => {
    try {
        const { id, secret, metrics } = req.body;
        if (secret !== API_SECRET) return res.status(401).send('Unauthorized');

        let countryCode = req.headers['cf-ipcountry'] || 'XX';
        if (countryCode.toUpperCase() === 'TW') countryCode = 'CN';

        const serverExists = db.prepare('SELECT id FROM servers WHERE id = ?').get(id);
        if (!serverExists) return res.status(404).send('Server not found');

        db.prepare(`
          UPDATE servers 
          SET cpu = ?, ram = ?, disk = ?, load_avg = ?, uptime = ?, last_updated = ?,
              ram_total = ?, net_rx = ?, net_tx = ?, net_in_speed = ?, net_out_speed = ?,
              os = ?, cpu_info = ?, arch = ?, boot_time = ?, ram_used = ?, swap_total = ?, 
              swap_used = ?, disk_total = ?, disk_used = ?, processes = ?, tcp_conn = ?, udp_conn = ?, 
              country = ?, ip_v4 = ?, ip_v6 = ?
          WHERE id = ?
        `).run(
          metrics.cpu, metrics.ram, metrics.disk, metrics.load, metrics.uptime, Date.now(),
          metrics.ram_total || '0', metrics.net_rx || '0', metrics.net_tx || '0', 
          metrics.net_in_speed || '0', metrics.net_out_speed || '0', 
          metrics.os || '', metrics.cpu_info || '', metrics.arch || '', metrics.boot_time || '',
          metrics.ram_used || '0', metrics.swap_total || '0', metrics.swap_used || '0',
          metrics.disk_total || '0', metrics.disk_used || '0', metrics.processes || '0',
          metrics.tcp_conn || '0', metrics.udp_conn || '0', countryCode, 
          metrics.ip_v4 || '0', metrics.ip_v6 || '0', id
        );

        checkOfflineNodes().catch(console.error);
        res.status(200).send('OK');
    } catch (e) {
        res.status(400).send('Error');
    }
});

app.get('/api/server', (req, res) => {
    const sys = getSysSettings();
    if (sys.is_public !== 'true' && !checkAuth(req)) {
        res.setHeader('WWW-Authenticate', `Basic realm="${sys.site_title}"`);
        return res.status(401).send('Unauthorized');
    }
    const id = req.query.id;
    if (!id) return res.status(400).send('Miss ID');
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
    if (!server) return res.status(404).send('Not Found');
    res.json(server);
});

app.get('/', (req, res) => {
    const sys = getSysSettings();
    if (sys.is_public !== 'true' && !checkAuth(req)) {
        res.setHeader('WWW-Authenticate', `Basic realm="${sys.site_title}"`);
        return res.status(401).send('Unauthorized');
    }

    const viewId = req.query.id;

    if (viewId) {
        const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(viewId);
        if (!server) return res.status(404).send('Server not found');

        const detailHtml = `<!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>${server.name} - ${sys.site_title}</title>
          <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f9fafb; color: #333; margin: 0; padding: 20px; }
            .container { max-width: 1200px; margin: 0 auto; }
            .header-card { background: white; padding: 24px; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 20px; }
            .title-row { display: flex; align-items: center; margin-bottom: 16px; }
            .title-row h2 { margin: 0; font-size: 24px; margin-right: 12px; display: flex; align-items: center;}
            .status-badge { background: #10b981; color: white; padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: bold; }
            .info-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; font-size: 14px; }
            .info-item { display: flex; flex-direction: column; }
            .info-label { color: #6b7280; font-size: 12px; margin-bottom: 4px; }
            .info-value { font-weight: 500; }
            .charts-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(350px, 1fr)); gap: 20px; }
            .chart-card { background: white; padding: 20px; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
            .chart-card h3 { margin-top: 0; font-size: 16px; color: #374151; display: flex; justify-content: space-between; align-items: center; }
            .chart-val { font-size: 18px; font-weight: bold; }
            canvas { max-height: 150px; }
            .back-btn { display: inline-block; margin-bottom: 15px; color: #3b82f6; text-decoration: none; font-weight: 500; }
            ${getThemeStyles(sys)}
          </style>
        </head>
        <body class="${sys.theme || 'theme1'}">
          <div class="container">
            <a href="/" class="back-btn">⬅ 返回大盘</a>
            <div class="header-card">
              <div class="title-row">
                <h2><span id="head-flag"></span> ${server.name}</h2>
                <span class="status-badge" id="head-status">在线</span>
              </div>
              <div class="info-grid">
                <div class="info-item"><span class="info-label">运行时间</span><span class="info-value" id="val-uptime">...</span></div>
                <div class="info-item"><span class="info-label">架构</span><span class="info-value" id="val-arch">...</span></div>
                <div class="info-item"><span class="info-label">系统</span><span class="info-value" id="val-os">...</span></div>
                <div class="info-item"><span class="info-label">CPU</span><span class="info-value" id="val-cpuinfo">...</span></div>
                <div class="info-item"><span class="info-label">Load</span><span class="info-value" id="val-load">...</span></div>
                <div class="info-item"><span class="info-label">上传 / 下载</span><span class="info-value" id="val-traffic">...</span></div>
                <div class="info-item"><span class="info-label">启动时间</span><span class="info-value" id="val-boot">...</span></div>
              </div>
            </div>
            <div class="charts-grid">
              <div class="chart-card"><h3>CPU <span class="chart-val" id="text-cpu">0%</span></h3><canvas id="chartCPU"></canvas></div>
              <div class="chart-card"><h3>内存 <span class="chart-val" id="text-ram">0%</span></h3><div style="font-size:12px; color:#6b7280; margin-bottom:5px;" id="text-swap">Swap: 0 / 0</div><canvas id="chartRAM"></canvas></div>
              <div class="chart-card"><h3>磁盘 <span class="chart-val" id="text-disk">0%</span></h3><div style="width:100%; height:20px; background:#e5e7eb; border-radius:10px; overflow:hidden; margin-top:40px;"><div id="disk-bar" style="height:100%; width:0%; background:#34d399; transition:width 0.5s;"></div></div><p style="text-align:right; font-size:12px; color:#6b7280; margin-top:8px;" id="text-disk-detail">0 / 0</p></div>
              <div class="chart-card"><h3>进程数 <span class="chart-val" id="text-proc">0</span></h3><canvas id="chartProc"></canvas></div>
              <div class="chart-card"><h3>网络速度 <span class="chart-val" style="font-size:14px;"><span style="color:#10b981">↓</span> <span id="text-net-in">0</span> | <span style="color:#3b82f6">↑</span> <span id="text-net-out">0</span></span></h3><canvas id="chartNet"></canvas></div>
              <div class="chart-card"><h3>TCP / UDP <span class="chart-val" style="font-size:14px;">TCP <span id="text-tcp">0</span> | UDP <span id="text-udp">0</span></span></h3><canvas id="chartConn"></canvas></div>
            </div>
            ${footerHtml}
          </div>
          <script>
            const serverId = "${viewId}";
            const formatBytes = (bytes) => { const b = parseInt(bytes); if (isNaN(b) || b === 0) return '0 B'; const k = 1024; const sizes = ['B', 'KB', 'MB', 'GB', 'TB']; const i = Math.floor(Math.log(b) / Math.log(k)); return parseFloat((b / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]; };
            const commonOptions = { responsive: true, maintainAspectRatio: false, animation: { duration: 0 }, scales: { x: { display: false }, y: { beginAtZero: true, border: { display: false } } }, plugins: { legend: { display: false }, tooltip: { enabled: false } }, elements: { point: { radius: 0 }, line: { tension: 0.4, borderWidth: 2 } } };
            const createChart = (ctxId, color, bgColor) => { const ctx = document.getElementById(ctxId).getContext('2d'); return new Chart(ctx, { type: 'line', data: { labels: Array(30).fill(''), datasets: [{ data: Array(30).fill(0), borderColor: color, backgroundColor: bgColor, fill: true }] }, options: commonOptions }); };
            const charts = { cpu: createChart('chartCPU', '#3b82f6', 'rgba(59, 130, 246, 0.1)'), ram: createChart('chartRAM', '#8b5cf6', 'rgba(139, 92, 246, 0.1)'), proc: createChart('chartProc', '#ec4899', 'rgba(236, 72, 153, 0.1)') };
            const ctxNet = document.getElementById('chartNet').getContext('2d'); charts.net = new Chart(ctxNet, { type: 'line', data: { labels: Array(30).fill(''), datasets: [ { label: 'In', data: Array(30).fill(0), borderColor: '#10b981', borderWidth: 2, tension: 0.4, pointRadius: 0 }, { label: 'Out', data: Array(30).fill(0), borderColor: '#3b82f6', borderWidth: 2, tension: 0.4, pointRadius: 0 } ]}, options: commonOptions });
            const ctxConn = document.getElementById('chartConn').getContext('2d'); charts.conn = new Chart(ctxConn, { type: 'line', data: { labels: Array(30).fill(''), datasets: [ { label: 'TCP', data: Array(30).fill(0), borderColor: '#6366f1', borderWidth: 2, tension: 0.4, pointRadius: 0 }, { label: 'UDP', data: Array(30).fill(0), borderColor: '#d946ef', borderWidth: 2, tension: 0.4, pointRadius: 0 } ]}, options: commonOptions });
            const updateChartData = (chart, newData, datasetIndex = 0) => { const dataArr = chart.data.datasets[datasetIndex].data; dataArr.push(newData); dataArr.shift(); chart.update(); };

            async function fetchData() {
              try {
                const res = await fetch('/api/server?id=' + serverId); const data = await res.json();
                const cCode = (data.country || 'xx').toLowerCase();
                document.getElementById('head-flag').innerHTML = cCode !== 'xx' ? \`<img src="https://flagcdn.com/24x18/\${cCode}.png" alt="\${cCode}" style="vertical-align: middle; margin-right: 8px; border-radius: 2px;">\` : '🏳️ ';
                document.getElementById('val-uptime').innerText = data.uptime || 'N/A'; document.getElementById('val-arch').innerText = data.arch || 'N/A'; document.getElementById('val-os').innerText = data.os || 'N/A'; document.getElementById('val-cpuinfo').innerText = data.cpu_info || 'N/A'; document.getElementById('val-load').innerText = data.load_avg || '0.00'; document.getElementById('val-boot').innerText = data.boot_time || 'N/A'; document.getElementById('val-traffic').innerText = formatBytes(data.net_tx) + ' / ' + formatBytes(data.net_rx);
                const isOnline = (Date.now() - data.last_updated) < 30000;
                const badge = document.getElementById('head-status'); badge.innerText = isOnline ? '在线' : '离线'; badge.style.background = isOnline ? '#10b981' : '#ef4444';
                if(!isOnline) return;
                document.getElementById('text-cpu').innerText = data.cpu + '%'; document.getElementById('text-ram').innerText = data.ram + '%'; document.getElementById('text-swap').innerText = 'Swap: ' + data.swap_used + ' MiB / ' + data.swap_total + ' MiB'; document.getElementById('text-proc').innerText = data.processes || '0'; document.getElementById('text-net-in').innerText = formatBytes(data.net_in_speed) + '/s'; document.getElementById('text-net-out').innerText = formatBytes(data.net_out_speed) + '/s'; document.getElementById('text-tcp').innerText = data.tcp_conn || '0'; document.getElementById('text-udp').innerText = data.udp_conn || '0';
                let diskTotal = parseFloat(data.disk_total) || 0; let diskUsed = parseFloat(data.disk_used) || 0; let diskPct = parseInt(data.disk) || 0;
                document.getElementById('text-disk').innerText = diskPct + '%'; document.getElementById('disk-bar').style.width = diskPct + '%'; document.getElementById('text-disk-detail').innerText = (diskUsed/1024).toFixed(2) + ' GiB / ' + (diskTotal/1024).toFixed(2) + ' GiB';
                updateChartData(charts.cpu, parseFloat(data.cpu) || 0); updateChartData(charts.ram, parseFloat(data.ram) || 0); updateChartData(charts.proc, parseInt(data.processes) || 0); updateChartData(charts.net, parseFloat(data.net_in_speed) || 0, 0); updateChartData(charts.net, parseFloat(data.net_out_speed) || 0, 1); updateChartData(charts.conn, parseInt(data.tcp_conn) || 0, 0); updateChartData(charts.conn, parseInt(data.udp_conn) || 0, 1);
              } catch (e) {}
            }
            setInterval(fetchData, 3000); fetchData();
          </script>
        </body>
        </html>`;
        return res.send(detailHtml);
    }

    const results = db.prepare('SELECT * FROM servers').all();
    const now = Date.now();

    let globalOnline = 0; let globalOffline = 0;
    let globalSpeedIn = 0; let globalSpeedOut = 0;
    let globalNetTx = 0; let globalNetRx = 0;
    const groups = {};

    if (results && results.length > 0) {
        for (const server of results) {
            const isOnline = (now - server.last_updated) < 30000;
            if (isOnline) {
                globalOnline++;
                globalSpeedIn += parseFloat(server.net_in_speed) || 0;
                globalSpeedOut += parseFloat(server.net_out_speed) || 0;
            } else {
                globalOffline++;
            }
            globalNetTx += parseFloat(server.net_tx) || 0;
            globalNetRx += parseFloat(server.net_rx) || 0;

            const grpName = server.server_group || '默认分组';
            if (!groups[grpName]) groups[grpName] = [];
            groups[grpName].push(server);
        }
    }

    let contentHtml = '';
    if (Object.keys(groups).length === 0) {
        contentHtml = '<p style="text-align:center; width: 100%; color:#888;">暂无服务器，请在后台添加</p>';
    } else {
        for (const [grpName, grpServers] of Object.entries(groups)) {
            contentHtml += `<div class="group-header">${grpName}</div><div class="grid-container">`;
            for (const server of grpServers) {
                const isOnline = (now - server.last_updated) < 30000;
                const statusColor = isOnline ? '#10b981' : '#ef4444'; 
                
                const cpu = server.cpu || '0'; const ram = server.ram || '0'; const disk = server.disk || '0';
                const netInSpeed = formatBytes(server.net_in_speed); const netOutSpeed = formatBytes(server.net_out_speed);
                
                const cCode = (server.country || 'xx').toLowerCase();
                const flagHtml = cCode !== 'xx' ? `<img src="https://flagcdn.com/24x18/${cCode}.png" alt="${cCode}" style="vertical-align: sub; margin-right: 5px; border-radius: 2px;">` : '🏳️';
                
                let metaHtml = '';
                if (sys.show_price === 'true') {
                    metaHtml += `<div class="card-meta" style="margin-top:8px;">价格: ${server.price || '免费'}</div>`;
                }
                if (sys.show_expire === 'true') {
                    let expireText = '永久';
                    if (server.expire_date) {
                        const expTime = new Date(server.expire_date).getTime();
                        if (!isNaN(expTime)) {
                            const diff = expTime - now;
                            expireText = diff > 0 ? Math.ceil(diff / (1000 * 3600 * 24)) + ' 天' : '已过期';
                        }
                    }
                    metaHtml += `<div class="card-meta" style="${sys.show_price !== 'true' ? 'margin-top:8px;' : ''}">剩余天数: ${expireText}</div>`;
                }

                let badgesHtml = '';
                if (sys.show_bw === 'true' && server.bandwidth) badgesHtml += `<span class="badge badge-bw">${server.bandwidth}</span>`;
                if (sys.show_tf === 'true' && server.traffic_limit) badgesHtml += `<span class="badge badge-tf">${server.traffic_limit}</span>`;
                if (server.ip_v4 === '1') badgesHtml += `<span class="badge badge-v4">IPv4</span>`;
                if (server.ip_v6 === '1') badgesHtml += `<span class="badge badge-v6">IPv6</span>`;

                contentHtml += `
                    <a href="/?id=${server.id}" class="vps-card">
                        <div class="card-left">
                            <div class="card-title">
                                <div class="status-dot" style="background:${statusColor};"></div>
                                ${flagHtml} <span style="font-size:15px;" class="card-title-text">${server.name}</span>
                            </div>
                            ${metaHtml}
                            <div class="card-badges">${badgesHtml}</div>
                        </div>
                        
                        <div class="card-right">
                            <div class="stat-col"><div class="stat-label">CPU</div><div class="stat-val">${cpu}%</div><div class="stat-bar"><div style="width:${cpu}%;"></div></div></div>
                            <div class="stat-col"><div class="stat-label">内存</div><div class="stat-val">${ram}%</div><div class="stat-bar"><div style="width:${ram}%; background:#f59e0b;"></div></div></div>
                            <div class="stat-col"><div class="stat-label">存储</div><div class="stat-val">${disk}%</div><div class="stat-bar"><div style="width:${disk}%; background:#10b981;"></div></div></div>
                            <div class="stat-col"><div class="stat-label">上传</div><div class="stat-val">${netOutSpeed}/s</div></div>
                            <div class="stat-col"><div class="stat-label">下载</div><div class="stat-val">${netInSpeed}/s</div></div>
                        </div>
                    </a>
                `;
            }
            contentHtml += `</div>`;
        }
    }

    const html = `<!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${sys.site_title}</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background-color: #f4f5f7; color: #333; margin: 0; padding: 20px; }
        .container { max-width: 1200px; margin: 0 auto; }
        .global-stats { display: flex; flex-wrap: wrap; gap: 20px; justify-content: space-around; background: white; padding: 20px; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.03); margin-bottom: 30px; text-align: center; }
        .g-item { flex: 1; min-width: 200px; }
        .g-val { font-size: 24px; font-weight: bold; color: #111; margin: 8px 0; }
        .g-label { font-size: 13px; color: #666; }
        .g-sub { font-size: 12px; color: #999; }
        .group-header { font-size: 18px; font-weight: 600; color: #444; margin: 25px 0 15px 5px; border-left: 4px solid #3b82f6; padding-left: 10px; }
        .grid-container { display: grid; grid-template-columns: repeat(auto-fill, minmax(480px, 1fr)); gap: 15px; }
        .vps-card { display: flex; justify-content: space-between; align-items: stretch; background: white; padding: 18px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.04); text-decoration: none; color: inherit; border: 1px solid transparent; transition: all 0.2s ease; }
        .vps-card:hover { border-color: #e5e7eb; transform: translateY(-2px); box-shadow: 0 8px 15px rgba(0,0,0,0.08); }
        .card-left { flex: 0 0 180px; display: flex; flex-direction: column; justify-content: center; }
        .card-title { display: flex; align-items: center; margin-bottom: 4px; }
        .card-title-text { font-weight: 600; }
        .status-dot { width: 8px; height: 8px; border-radius: 50%; margin-right: 8px; flex-shrink:0; }
        .card-meta { font-size: 12px; color: #6b7280; margin-bottom: 3px; }
        .card-badges { margin-top: 10px; display: flex; gap: 5px; flex-wrap: wrap; }
        .badge { padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; color: white; }
        .badge-bw { background: #3b82f6; } .badge-tf { background: #10b981; } .badge-v4 { background: #a855f7; } .badge-v6 { background: #ec4899; }
        .card-right { flex: 1; display: flex; justify-content: space-between; align-items: center; padding-left: 15px; border-left: 1px solid #f0f0f0; }
        .stat-col { display: flex; flex-direction: column; align-items: center; width: 50px; }
        .stat-label { font-size: 11px; color: #888; margin-bottom: 8px; }
        .stat-val { font-size: 13px; font-weight: 600; color: #111; margin-bottom: 6px; }
        .stat-bar { width: 100%; height: 3px; background: #e5e7eb; border-radius: 2px; overflow: hidden; }
        .stat-bar > div { height: 100%; background: #3b82f6; border-radius: 2px; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 30px; }
        .admin-btn { padding: 8px 16px; background: #3b82f6; color: white; text-decoration: none; border-radius: 6px; font-size: 14px; font-weight:bold; }
        @media (max-width: 600px) { .grid-container { grid-template-columns: 1fr; } .vps-card { flex-direction: column; } .card-right { padding-left: 0; border-left: none; border-top: 1px solid #f0f0f0; margin-top: 15px; padding-top: 15px; } }
        ${getThemeStyles(sys)}
      </style>
      <meta http-equiv="refresh" content="5">
    </head>
    <body class="${sys.theme || 'theme1'}">
      <div class="container">
        <div class="header">
          <h1 style="margin:0;">${sys.site_title}</h1>
          <a href="/admin" class="admin-btn">${sys.admin_title}</a>
        </div>
        <div class="global-stats">
          <div class="g-item"><div class="g-label">服务器总数</div><div class="g-val">${results.length}</div><div class="g-sub">在线 <span style="color:#10b981">${globalOnline}</span> | 离线 <span style="color:#ef4444">${globalOffline}</span></div></div>
          <div class="g-item"><div class="g-label">总计流量 (入 | 出)</div><div class="g-val">${formatBytes(globalNetRx)} | ${formatBytes(globalNetTx)}</div></div>
          <div class="g-item"><div class="g-label">实时网速 (入 | 出)</div><div class="g-val"><span style="color:#10b981">↓</span> ${formatBytes(globalSpeedIn)}/s | <span style="color:#3b82f6">↑</span> ${formatBytes(globalSpeedOut)}/s</div></div>
        </div>
        ${contentHtml}
        ${footerHtml}
      </div>
    </body>
    </html>`;

    res.send(html);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server Monitor Pro (Node Edition) running on port ${PORT}`);
    console.log(`Database mounted at ${DB_PATH}`);
});
