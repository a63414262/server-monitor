import express from 'express';
import expressWs from 'express-ws';
import { Client } from 'ssh2';
import { SocksClient } from 'socks'; 
import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const app = express();
expressWs(app);
app.use(express.json({ limit: '10mb' }));

// ==========================================
// 容器环境变量配置 (含 GitHub OAuth & CF Zero Trust)
// ==========================================
const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || 'admin123'; 
const DB_PATH = process.env.DB_PATH || '/app/data/monitor.db';

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const GITHUB_ALLOWED_USERS = (process.env.GITHUB_ALLOWED_USERS || '').split(',').map(u => u.trim().toLowerCase()).filter(Boolean);

const CF_TEAM_NAME = process.env.CF_TEAM_NAME || '';
const CF_CLIENT_ID = process.env.CF_CLIENT_ID || '';
const CF_CLIENT_SECRET = process.env.CF_CLIENT_SECRET || '';

const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ==========================================
// 核心安全升级：主控端本地生成专属 SSH 密钥对
// ==========================================
const SSH_KEY_DIR = path.join(dbDir, 'ssh_keys');
const PRIVATE_KEY_PATH = path.join(SSH_KEY_DIR, 'id_rsa');
const PUBLIC_KEY_PATH = path.join(SSH_KEY_DIR, 'id_rsa.pub');

if (!fs.existsSync(SSH_KEY_DIR)) {
    fs.mkdirSync(SSH_KEY_DIR, { recursive: true });
}

if (!fs.existsSync(PRIVATE_KEY_PATH) || !fs.existsSync(PUBLIC_KEY_PATH)) {
    console.log('正在生成主控端安全 SSH 密钥对...');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    const sshRsaPub = "ssh-rsa " + Buffer.from(publicKey.split('\n').filter(l => l && !l.startsWith('---')).join(''), 'base64').toString('base64') + " Server-Monitor-Pro-Master";
    fs.writeFileSync(PRIVATE_KEY_PATH, privateKey);
    fs.writeFileSync(PUBLIC_KEY_PATH, sshRsaPub);
    console.log('✅ 主控端专属 SSH 密钥对已安全生成！');
}
const MASTER_PUBLIC_KEY = fs.readFileSync(PUBLIC_KEY_PATH, 'utf-8');
const MASTER_PRIVATE_KEY = fs.readFileSync(PRIVATE_KEY_PATH, 'utf-8');

// 初始化表结构
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, username TEXT, created_at INTEGER);
  CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY, name TEXT, cpu TEXT, ram TEXT, disk TEXT, load_avg TEXT,
    uptime TEXT, last_updated INTEGER, ram_total TEXT, net_rx TEXT, net_tx TEXT,
    net_in_speed TEXT, net_out_speed TEXT, os TEXT, cpu_info TEXT, country TEXT,
    server_group TEXT, price TEXT, expire_date TEXT, bandwidth TEXT, traffic_limit TEXT,
    ip_v4 TEXT, ip_v6 TEXT, arch TEXT, boot_time TEXT, ram_used TEXT, swap_total TEXT,
    swap_used TEXT, disk_total TEXT, disk_used TEXT, processes TEXT, tcp_conn TEXT, udp_conn TEXT,
    ping_ct TEXT, ping_cu TEXT, ping_cm TEXT, ping_bd TEXT,
    ssh_host TEXT, ssh_port TEXT, ssh_user TEXT, ssh_pass TEXT
  );
  CREATE TABLE IF NOT EXISTS ip_reports (
    id TEXT PRIMARY KEY, server_id TEXT, created_at INTEGER, report_text TEXT
  );
`);

// 【核心修复】：逐个列独立校验升级，防止一个报错导致后续全部中断
const addColumn = (table, column, def) => {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT DEFAULT '${def}'`); } catch (e) {}
};
addColumn('servers', 'ssh_host', '');
addColumn('servers', 'ssh_port', '22');
addColumn('servers', 'ssh_user', 'root');
addColumn('servers', 'ssh_pass', '');
addColumn('servers', 'ping_ct', '0');
addColumn('servers', 'ping_cu', '0');
addColumn('servers', 'ping_cm', '0');
addColumn('servers', 'ping_bd', '0');

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
        admin_title: '⚙️ 资产与探针控制台',
        theme: 'theme1', custom_bg: '', is_public: 'true', show_price: 'true',
        show_expire: 'true', show_bw: 'true', show_tf: 'true', tg_notify: 'false',
        tg_bot_token: '', tg_chat_id: ''
    };
    try {
        const results = db.prepare('SELECT * FROM settings').all();
        results.forEach(r => sys[r.key] = r.value);
    } catch (e) {}
    return sys;
};

// ==========================================
// GitHub OAuth 核心逻辑
// ==========================================
const parseCookies = (request) => {
    const list = {};
    const rc = request.headers.cookie;
    rc && rc.split(';').forEach(cookie => {
        const parts = cookie.split('=');
        list[parts.shift().trim()] = decodeURI(parts.join('='));
    });
    return list;
};

const checkWebAuth = (req) => {
    const cookies = parseCookies(req);
    const token = cookies['admin_session'];
    if (!token) return false;
    const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
    return session && (Date.now() - session.created_at < 7 * 24 * 3600 * 1000);
};

const requireWebAuth = (req, res, next) => {
    if (!checkWebAuth(req)) {
        if (req.path.startsWith('/admin/api')) return res.status(401).json({ error: 'Unauthorized' });
        return res.redirect('/auth/github'); 
    }
    next();
};

app.get('/auth/github', (req, res) => {
    if (!GITHUB_CLIENT_ID) return res.send('系统未配置 GitHub Client ID 环境变量！');
    res.redirect(`https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}`);
});

app.get('/auth/github/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.send('授权失败：未提供 Code');
    try {
        const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET, code: code })
        });
        const tokenData = await tokenRes.json();
        if (tokenData.error) return res.send('GitHub Auth Error: ' + tokenData.error_description);

        const userRes = await fetch('https://api.github.com/user', {
            headers: { 'Authorization': `Bearer ${tokenData.access_token}`, 'User-Agent': 'Server-Monitor-Pro' }
        });
        const userData = await userRes.json();
        const username = (userData.login || '').toLowerCase();

        if (GITHUB_ALLOWED_USERS.length > 0 && !GITHUB_ALLOWED_USERS.includes(username)) {
            return res.status(403).send(`<h2>❌ 拒绝访问</h2><p>您的 GitHub 账号 (@${username}) 不在系统白名单中。</p><a href="/">返回首页</a>`);
        }

        const sessionToken = crypto.randomBytes(32).toString('hex');
        db.prepare('INSERT INTO sessions (token, username, created_at) VALUES (?, ?, ?)').run(sessionToken, username, Date.now());
        res.cookie('admin_session', sessionToken, { maxAge: 7 * 24 * 3600 * 1000, httpOnly: true });
        res.redirect('/admin');
    } catch (err) { res.status(500).send('Authentication failed.'); }
});

app.get('/logout', (req, res) => {
    const cookies = parseCookies(req);
    const token = cookies['admin_session'];
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    res.clearCookie('admin_session');
    res.redirect('/');
});

// ==========================================
// Web SSH 终端逻辑 (基于 Zero Trust + 自动密钥免密)
// ==========================================
app.ws('/ssh', (ws, req) => {
    if (!checkWebAuth(req)) {
        ws.send(JSON.stringify({ type: 'error', msg: '会话已过期，请重新登录！' }));
        ws.close();
        return;
    }
    const conn = new Client();
    let streamObj = null;

    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);
            if (data.type === 'connect') {
                const server = db.prepare('SELECT ssh_host, ssh_port, ssh_user, ssh_pass FROM servers WHERE id = ?').get(data.serverId);
                if (!server) return ws.send(JSON.stringify({ type: 'error', msg: '找不到服务器记录！' }));

                const targetHost = data.host || server.ssh_host;
                const targetPort = parseInt(data.port || server.ssh_port || 22);
                const authUser = data.username || server.ssh_user || 'root';
                const authPass = data.password || server.ssh_pass || '';

                if (!targetHost) {
                    ws.send(JSON.stringify({ type: 'error', msg: '\r\n❌ 缺少 IP 地址，请等待探针上报！\r\n' }));
                    return;
                }

                const sshConfig = { username: authUser, privateKey: MASTER_PRIVATE_KEY, tryKeyboard: true };
                const isIPv6 = targetHost.includes(':');

                conn.on('ready', () => {
                    ws.send(JSON.stringify({ type: 'status', msg: '\r\n✅ 鉴权成功，已连接到服务器...\r\n' }));
                    conn.shell({ term: 'xterm-color' }, (err, stream) => {
                        if (err) return ws.send(JSON.stringify({ type: 'error', msg: '\r\n❌ Shell 创建失败: ' + err.message + '\r\n' }));
                        streamObj = stream;
                        stream.on('data', (d) => ws.send(JSON.stringify({ type: 'data', data: d.toString('utf-8') })));
                        stream.on('close', () => {
                            ws.send(JSON.stringify({ type: 'status', msg: '\r\n🔌 连接已断开。\r\n' }));
                            conn.end(); ws.close();
                        });
                    });
                }).on('error', (err) => {
                    ws.send(JSON.stringify({ type: 'error', msg: '\r\n❌ 连接失败: ' + err.message + '\r\n' }));
                }).on('keyboard-interactive', (name, instr, lang, prompts, finish) => {
                    finish([authPass]);
                });

                if (isIPv6 && !targetHost.startsWith('fd00:')) {
                    ws.send(JSON.stringify({ type: 'status', msg: '\r\n🌐 探测到公网 IPv6 目标，启动 WARP SOCKS5 隧道穿透...\r\n' }));
                    SocksClient.createConnection({
                        proxy: { ipaddress: '127.0.0.1', port: 40000, type: 5 },
                        command: 'connect', destination: { host: targetHost, port: targetPort }
                    }, (err, info) => {
                        if (err) return ws.send(JSON.stringify({ type: 'error', msg: '\r\n❌ WARP 代理失败: ' + err.message + '\r\n' }));
                        conn.connect({ sock: info.socket, ...sshConfig });
                    });
                } else {
                    conn.connect({ host: targetHost, port: targetPort, ...sshConfig });
                }
            } else if (data.type === 'data' && streamObj) streamObj.write(data.data);
            else if (data.type === 'resize' && streamObj) streamObj.setWindow(data.rows, data.cols, 800, 600);
        } catch (e) {}
    });
    ws.on('close', () => conn.end());
});

// ==========================================
// 离线告警与 API 路由
// ==========================================
const sendTelegram = async (sys, msg) => {
    if (sys.tg_notify !== 'true' || !sys.tg_bot_token || !sys.tg_chat_id) return;
    try {
        await fetch(`https://api.telegram.org/bot${sys.tg_bot_token}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
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
            const isOffline = (now - s.last_updated) > 120000;
            if (isOffline && !alertState[s.id]) {
                await sendTelegram(sys, `⚠️ <b>节点离线告警</b>\n\n<b>节点名称:</b> ${s.name}\n<b>状态:</b> 离线 (超过2分钟未上报)\n<b>时间:</b> ${new Date().toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'})}`);
                alertState[s.id] = true; stateChanged = true;
            } else if (!isOffline && alertState[s.id]) {
                await sendTelegram(sys, `✅ <b>节点恢复通知</b>\n\n<b>节点名称:</b> ${s.name}\n<b>状态:</b> 恢复在线\n<b>时间:</b> ${new Date().toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'})}`);
                delete alertState[s.id]; stateChanged = true;
            }
        }
        if (stateChanged) db.prepare('INSERT INTO settings (key, value) VALUES ("alert_state", ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(JSON.stringify(alertState));
    } catch (e) {}
};

app.post('/admin/api', requireWebAuth, (req, res) => {
    try {
        const data = req.body;
        if (data.action === 'save_settings') {
            const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
            db.transaction(() => { for (const [k, v] of Object.entries(data.settings)) stmt.run(k, v); })();
            res.json({ success: true });
        } 
        else if (data.action === 'add') {
            db.prepare(`INSERT INTO servers (id, name, cpu, ram, disk, load_avg, uptime, last_updated, ram_total, net_rx, net_tx, net_in_speed, net_out_speed, os, cpu_info, country, server_group, price, expire_date, bandwidth, traffic_limit, ip_v4, ip_v6, ping_ct, ping_cu, ping_cm, ping_bd, ssh_host, ssh_port, ssh_user, ssh_pass) VALUES (?, ?, '0', '0', '0', '0', '0', 0, '0', '0', '0', '0', '0', '', '', '', '默认分组', '免费', '', '', '', '0', '0', '0', '0', '0', '0', '', '22', 'root', '')`).run(crypto.randomUUID(), data.name || 'New Server');
            res.json({ success: true });
        } 
        else if (data.action === 'delete') {
            db.prepare('DELETE FROM servers WHERE id = ?').run(data.id);
            res.json({ success: true });
        } 
        else if (data.action === 'edit') {
            db.prepare(`UPDATE servers SET server_group = ?, price = ?, expire_date = ?, bandwidth = ?, traffic_limit = ?, ssh_host = ?, ssh_port = ?, ssh_user = ?, ssh_pass = ? WHERE id = ?`).run(data.server_group || '默认分组', data.price || '', data.expire_date || '', data.bandwidth || '', data.traffic_limit || '', data.ssh_host || '', data.ssh_port || '22', data.ssh_user || 'root', data.ssh_pass || '', data.id);
            res.json({ success: true });
        }
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/admin', requireWebAuth, (req, res) => {
    const sys = getSysSettings();
    const results = db.prepare('SELECT id, name, last_updated, server_group, price, expire_date, bandwidth, traffic_limit, ssh_host, ssh_port, ssh_user FROM servers').all();
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
                        <button onclick="copyCmd('${s.id}')" class="btn btn-gray">复制命令</button>
                        <button onclick="openEditModal('${s.id}', '${s.server_group||''}', '${s.price||''}', '${s.expire_date||''}', '${s.bandwidth||''}', '${s.traffic_limit||''}', '${s.ssh_host||''}', '${s.ssh_port||'22'}', '${s.ssh_user||'root'}')" class="btn btn-blue">✏️ 编辑</button>
                        <button onclick="openIpHistoryModal('${s.id}', '${s.name}')" class="btn btn-purple">🌐 IP质量</button>
                        <button onclick="openSshModal('${s.id}', '${s.name}', '${s.ssh_host||''}', '${s.ssh_port||'22'}', '${s.ssh_user||'root'}')" class="btn btn-green">💻 SSH</button>
                        <button onclick="deleteServer('${s.id}')" class="btn btn-red">🗑️ 删除</button>
                    </td>
                </tr>
            `;
        }
    }

    res.send(`<!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>${sys.admin_title}</title>
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css" />
      <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script>
      <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 20px; background: #f0f2f5; color: #333;}
        .card { background: white; padding: 25px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); max-width: 1200px; margin: 0 auto 20px auto; position: relative;}
        h2 { margin-top: 0; border-bottom: 2px solid #f0f2f5; padding-bottom: 10px; font-size: 20px;}
        table { width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 14px; }
        th, td { border: 1px solid #eee; padding: 12px; text-align: left; }
        th { background: #f8f9fa; }
        .btn { cursor: pointer; border-radius: 4px; font-size: 13px; transition: opacity 0.2s; border: none; padding: 6px 10px; color: white; margin-left: 5px; text-decoration: none;}
        .btn:hover { opacity: 0.8; }
        .btn-blue { background: #3b82f6; } .btn-green { background: #10b981; } .btn-red { background: #ef4444; } .btn-gray { background: #6b7280; } .btn-purple { background: #8b5cf6; }
        .settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px; }
        .form-group { display: flex; flex-direction: column; margin-bottom: 15px; }
        .form-group label { font-size: 14px; font-weight: 600; margin-bottom: 6px; color: #555;}
        .form-group input[type="text"], .form-group input[type="number"], .form-group input[type="date"], .form-group select, .form-group input[type="password"] { padding: 10px; border: 1px solid #ccc; border-radius: 6px; }
        .checkbox-group { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; font-size: 14px;}
        .checkbox-group input { width: 18px; height: 18px; cursor: pointer; }
        .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 100; }
        .modal-content { background: white; padding: 20px; border-radius: 8px; width: 450px; margin: 100px auto; position: relative;}
        .modal-large { width: 850px; margin: 50px auto; }
        .modal input { width: 100%; padding: 8px; margin-bottom: 12px; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box;}
        .modal label { font-size: 14px; color: #555; display: block; margin-bottom: 4px; font-weight: bold;}
        #terminal-container, #ip-terminal-container { height: 450px; background: #000; padding: 10px; border-radius: 6px; margin-top: 15px; }
        .preset-btns { display: flex; gap: 8px; margin-bottom: 15px; flex-wrap: wrap; }
        .preset-btn { background: #e5e7eb; border: 1px solid #d1d5db; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; font-family: monospace; color: #374151; }
        .preset-btn:hover { background: #d1d5db; }
        .calc-result { background: #f3f4f6; padding: 15px; border-radius: 6px; margin-top: 15px; border-left: 4px solid #10b981; }
        .calc-result strong { color: #10b981; font-size: 20px; }
      </style>
    </head>
    <body>
      <div class="card">
        <a href="/logout" class="btn btn-red" style="position: absolute; right: 180px; top: 25px; font-weight: bold; padding: 8px 15px;">退出登录</a>
        <button onclick="openCalcModal()" class="btn btn-purple" style="position: absolute; right: 25px; top: 25px; font-weight: bold; padding: 8px 15px;">🧮 剩余价值计算器</button>
        <h2>🛠️ 全局设置</h2>
        <div class="settings-grid">
          <div>
            <div class="form-group">
              <label>🎨 前端主题风格 (5选1)</label>
              <select id="cfg_theme">
                <option value="theme1" ${sys.theme === 'theme1' ? 'selected' : ''}>1. 默认清爽白</option>
                <option value="theme2" ${sys.theme === 'theme2' ? 'selected' : ''}>2. 暗黑极客</option>
                <option value="theme3" ${sys.theme === 'theme3' ? 'selected' : ''}>3. 新粗野主义</option>
                <option value="theme4" ${sys.theme === 'theme4' ? 'selected' : ''}>4. 动态渐变</option>
                <option value="theme5" ${sys.theme === 'theme5' ? 'selected' : ''}>5. 赛博朋克</option>
              </select>
            </div>
            <div class="form-group"><label>🖼️ 自定义背景图片 URL</label><input type="text" id="cfg_custom_bg" value="${sys.custom_bg || ''}"></div>
            <div class="form-group"><label>前台看板标题</label><input type="text" id="cfg_site_title" value="${sys.site_title}"></div>
            <div class="form-group"><label>后台标签栏名称</label><input type="text" id="cfg_admin_title" value="${sys.admin_title}"></div>
          </div>
          <div>
            <label style="font-size: 14px; font-weight: 600; margin-bottom: 10px; display: block; color: #555;">👁️ 前台展示控制</label>
            <div class="checkbox-group"><input type="checkbox" id="cfg_is_public" ${sys.is_public === 'true' ? 'checked' : ''}><label><b>公开访问</b> (取消勾选须 GitHub 登录)</label></div>
            <div class="checkbox-group"><input type="checkbox" id="cfg_show_price" ${sys.show_price === 'true' ? 'checked' : ''}><label>显示 <b>价格</b></label></div>
            <div class="checkbox-group"><input type="checkbox" id="cfg_show_expire" ${sys.show_expire === 'true' ? 'checked' : ''}><label>显示 <b>到期时间</b></label></div>
            <div class="checkbox-group"><input type="checkbox" id="cfg_show_bw" ${sys.show_bw === 'true' ? 'checked' : ''}><label>显示 <b>带宽徽章</b></label></div>
            <div class="checkbox-group"><input type="checkbox" id="cfg_show_tf" ${sys.show_tf === 'true' ? 'checked' : ''}><label>显示 <b>流量配额徽章</b></label></div>
            <hr style="margin: 20px 0; border: none; border-top: 1px dashed #ccc;">
            <label style="font-size: 14px; font-weight: 600; margin-bottom: 10px; display: block; color: #e63946;">✈️ Telegram 离线告警设置</label>
            <div class="form-group"><label>开启离线通知</label><select id="cfg_tg_notify"><option value="false" ${sys.tg_notify !== 'true' ? 'selected' : ''}>关闭告警</option><option value="true" ${sys.tg_notify === 'true' ? 'selected' : ''}>开启告警</option></select></div>
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
          <div style="display:flex; gap:10px;">
            <div style="flex:1"><label>分组名称</label> <input type="text" id="editGroup" placeholder="如：美国 VPS"></div>
            <div style="flex:1"><label>价格</label> <input type="text" id="editPrice" placeholder="如：40USD/Year"></div>
          </div>
          <label>到期时间</label> <input type="date" id="editExpire">
          <div style="display:flex; gap:10px;">
            <div style="flex:1"><label>带宽</label> <input type="text" id="editBandwidth" placeholder="如：1Gbps"></div>
            <div style="flex:1"><label>流量总量</label> <input type="text" id="editTraffic" placeholder="如：1TB/月"></div>
          </div>
          
          <hr style="margin: 15px 0; border: none; border-top: 1px dashed #ccc;">
          <label style="color:#8b5cf6;">💻 SSH 直连高级配置</label>
          <div style="display:flex; gap:10px;">
            <div style="flex:1"><label>连接 IP</label><input type="text" id="editSshHost" placeholder="探针已自动获取，可手动覆盖"></div>
            <div style="width:70px"><label>端口</label><input type="text" id="editSshPort" placeholder="22"></div>
          </div>
          <div style="display:flex; gap:10px;">
            <div style="flex:1"><label>用户名</label><input type="text" id="editSshUser" placeholder="root"></div>
            <div style="flex:1"><label>临时密码</label><input type="password" id="editSshPass" placeholder="(已开启私钥秒连,无需填)"></div>
          </div>

          <div style="text-align: right; margin-top: 10px;">
            <button onclick="closeModal('editModal')" style="padding: 8px 15px; border: 1px solid #ccc; background: white; margin-right: 5px; cursor:pointer;">取消</button>
            <button onclick="saveEdit()" class="btn btn-blue" style="padding: 8px 15px;">保存更改</button>
          </div>
        </div>
      </div>

      <div id="calcModal" class="modal">
        <div class="modal-content">
          <h3 style="margin-top:0;">🧮 VPS 剩余价值计算器</h3>
          <div class="form-group"><label>原价/购买金额</label><input type="number" id="calcPrice" placeholder="例如: 39.9"></div>
          <div class="form-group">
            <label>购买周期</label>
            <select id="calcCycle">
              <option value="365">年付 (365天)</option><option value="180">半年付 (180天)</option>
              <option value="90">季付 (90天)</option><option value="30">月付 (30天)</option>
            </select>
          </div>
          <div class="form-group"><label>到期时间</label><input type="date" id="calcExpire"></div>
          <div class="form-group"><label>溢价 / 砍价</label><input type="number" id="calcPremium" value="0"></div>
          <button onclick="calculateValue()" class="btn btn-purple" style="width: 100%; padding: 10px; font-size: 15px;">🚀 开始计算</button>
          <div id="calcResult" class="calc-result" style="display:none;">
            <div>剩余天数: <span id="resDays">0</span> 天</div>
            <div>日均成本: <span id="resDaily">0</span></div>
            <div style="margin-top:10px;">明盘建议价: <br><strong id="resFinal">0.00</strong></div>
          </div>
          <div style="text-align: right; margin-top: 15px;">
            <button onclick="closeModal('calcModal')" style="padding: 8px 15px; border: 1px solid #ccc; background: white; cursor:pointer;">关闭</button>
          </div>
        </div>
      </div>

      <div id="ipHistoryModal" class="modal">
        <div class="modal-content modal-large">
          <h3 style="margin-top:0; display:flex; justify-content:space-between; align-items:center;">
            <span>🌐 IP 质量历史记录 - <span id="ipHistoryTargetName"></span></span>
            <button onclick="closeModal('ipHistoryModal')" style="border:none; background:none; font-size:20px; cursor:pointer;">✖</button>
          </h3>
          <div style="margin-bottom: 15px; display: flex; align-items: center; gap: 10px;">
            <label>⏱️ 选择时间：</label>
            <select id="ipHistorySelect" onchange="renderIpReport(this.value)" style="padding: 6px; border-radius: 4px; border: 1px solid #ccc; flex: 1;"></select>
            <button class="btn btn-green" onclick="refreshIpHistory()">🔄 刷新</button>
          </div>
          <div id="ip-terminal-container"></div>
        </div>
      </div>

      <div id="sshModal" class="modal">
        <div class="modal-content modal-large">
          <h3 style="margin-top:0; display:flex; justify-content:space-between; align-items:center;">
            <span>💻 Web SSH 直连 - <span id="sshTargetName"></span></span>
            <button onclick="closeSshModal()" style="border:none; background:none; font-size:20px; cursor:pointer;">✖</button>
          </h3>
          <input type="hidden" id="sshServerId">
          <div style="display:flex; gap:10px; margin-bottom: 15px; align-items:flex-end;">
            <div style="flex:1;"><label>目标IP/域名</label><input type="text" id="sshHost" placeholder="探针已自动获取，可手动覆盖"></div>
            <div style="width:80px;"><label>端口</label><input type="text" id="sshPort" placeholder="22"></div>
            <div style="width:120px;"><label>用户名</label><input type="text" id="sshUser" placeholder="root"></div>
            <div style="flex:1;"><label>密码(若私钥失败可填此)</label><input type="password" id="sshPass" placeholder="🔑 已全自动发卡免密"></div>
            <button onclick="connectSsh()" class="btn btn-green" style="padding: 10px 20px; margin-bottom:12px;">⚡ 连接</button>
          </div>
          <div class="preset-btns">
            <button class="preset-btn" onclick="sendCmd('clear\\n')">🧹 清屏</button>
            <button class="preset-btn" onclick="sendCmd('apt update && apt upgrade -y\\n')">🔄 更新系统</button>
            <button class="preset-btn" onclick="sendCmd('curl -sL yabs.sh | bash\\n')">🛠️ 综合测试</button>
            <button class="preset-btn" onclick="sendCmd('/usr/local/bin/cf-ip-check.sh\\n')">🌐 手动跑IP监控</button>
            <button class="preset-btn" style="background:#fef08a; border-color:#eab308; font-weight:bold; color:#854d0e;" onclick="sendCmd('/usr/local/bin/cf-ip-warm.sh\\n')">🛡️ 原生防送中/IP洗白</button>
            <button class="preset-btn" onclick="sendCmd('top\\n')">📊 查看 Top</button>
            <button class="preset-btn" onclick="sendCmd('df -h\\n')">💾 磁盘信息</button>
          </div>
          <div id="terminal-container"></div>
        </div>
      </div>
      
      <script>
        // 【核心修复】：增加 API 统一请求层，如果因为重启导致 Session 失效，会明确提示你刷新页面
        async function apiCall(data) {
            const res = await fetch('/admin/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
            if (res.status === 401) {
                alert('⚠️ 会话已过期或主控端刚重启，请点击确定后重新授权登录！');
                location.reload();
                return false;
            }
            if (!res.ok) {
                const err = await res.json();
                alert('操作失败: ' + (err.error || '未知错误'));
                return false;
            }
            return true;
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
          if (await apiCall(data)) { alert('✅ 设置已保存！'); location.reload(); }
        }

        async function addServer() {
          const name = document.getElementById('newName').value;
          if (!name) return alert('请输入名称');
          if (await apiCall({ action: 'add', name })) location.reload();
        }

        async function deleteServer(id) {
          if (!confirm('确定要删除这个节点吗？')) return;
          if (await apiCall({ action: 'delete', id })) location.reload();
        }

        function copyCmd(id) {
          const input = document.getElementById('cmd-' + id);
          input.select(); document.execCommand('copy');
          alert('✅ 一键安装命令已复制！');
        }

        function openEditModal(id, group, price, expire, bw, traffic, shost, sport, suser) {
          document.getElementById('editId').value = id;
          document.getElementById('editGroup').value = group || '默认分组';
          document.getElementById('editPrice').value = price || '免费';
          document.getElementById('editExpire').value = expire || '';
          document.getElementById('editBandwidth').value = bw || '';
          document.getElementById('editTraffic').value = traffic || '';
          document.getElementById('editSshHost').value = shost || '';
          document.getElementById('editSshPort').value = sport || '22';
          document.getElementById('editSshUser').value = suser || 'root';
          document.getElementById('editSshPass').value = '';
          document.getElementById('editModal').style.display = 'block';
        }

        function closeModal(id) { document.getElementById(id).style.display = 'none'; }

        async function saveEdit() {
          const data = {
            action: 'edit', id: document.getElementById('editId').value,
            server_group: document.getElementById('editGroup').value, price: document.getElementById('editPrice').value,
            expire_date: document.getElementById('editExpire').value, bandwidth: document.getElementById('editBandwidth').value,
            traffic_limit: document.getElementById('editTraffic').value,
            ssh_host: document.getElementById('editSshHost').value,
            ssh_port: document.getElementById('editSshPort').value,
            ssh_user: document.getElementById('editSshUser').value,
            ssh_pass: document.getElementById('editSshPass').value
          };
          if (await apiCall(data)) location.reload();
        }

        function openCalcModal() { document.getElementById('calcModal').style.display = 'block'; }
        function calculateValue() {
            const price = parseFloat(document.getElementById('calcPrice').value);
            const cycle = parseInt(document.getElementById('calcCycle').value);
            const expireDate = new Date(document.getElementById('calcExpire').value);
            const premium = parseFloat(document.getElementById('calcPremium').value) || 0;
            if (isNaN(price) || isNaN(expireDate.getTime())) return alert('请填写正确日期');
            const remainDays = Math.ceil((expireDate.getTime() - new Date().getTime()) / (1000 * 3600 * 24));
            if (remainDays <= 0) return alert('该机器已到期');
            const dailyPrice = price / cycle;
            const finalPrice = (dailyPrice * remainDays) + premium;
            document.getElementById('resDays').innerText = remainDays;
            document.getElementById('resDaily').innerText = dailyPrice.toFixed(4);
            document.getElementById('resFinal').innerText = Math.max(0, finalPrice).toFixed(2);
            document.getElementById('calcResult').style.display = 'block';
        }

        let ipHistoryTerm, ipHistoryFit, currentIpHistory = [], currentIpServerId = '';
        async function openIpHistoryModal(id, name) {
            currentIpServerId = id;
            document.getElementById('ipHistoryTargetName').innerText = name;
            document.getElementById('ipHistoryModal').style.display = 'block';
            if (!ipHistoryTerm) {
                ipHistoryTerm = new Terminal({ convertEol: true, theme: { background: '#000' } });
                ipHistoryFit = new FitAddon.FitAddon();
                ipHistoryTerm.loadAddon(ipHistoryFit);
                ipHistoryTerm.open(document.getElementById('ip-terminal-container'));
            }
            setTimeout(() => ipHistoryFit.fit(), 100);
            await refreshIpHistory();
        }
        async function refreshIpHistory() {
            ipHistoryTerm.clear();
            ipHistoryTerm.writeln('\\x1b[33m正在拉取 IP 质量体检记录...\\x1b[0m');
            const res = await fetch('/api/ip-history?id=' + currentIpServerId);
            currentIpHistory = await res.json();
            const select = document.getElementById('ipHistorySelect');
            select.innerHTML = '';
            if (currentIpHistory.length === 0) {
                ipHistoryTerm.clear();
                ipHistoryTerm.writeln('\\x1b[31m暂无 IP 质量体检记录。\\x1b[0m');
                return;
            }
            currentIpHistory.forEach((item, index) => {
                const opt = document.createElement('option');
                opt.value = index; opt.text = new Date(item.created_at).toLocaleString();
                select.appendChild(opt);
            });
            renderIpReport(0);
        }
        function renderIpReport(index) {
            if(!currentIpHistory[index]) return;
            ipHistoryTerm.clear();
            ipHistoryTerm.write(currentIpHistory[index].report_text);
        }

        let term, fitAddon, ws;
        function openSshModal(id, name, host, port, user) {
            document.getElementById('sshServerId').value = id;
            document.getElementById('sshTargetName').innerText = name;
            document.getElementById('sshHost').value = host || '';
            document.getElementById('sshPort').value = port || '22';
            document.getElementById('sshUser').value = user || 'root';
            document.getElementById('sshPass').value = '';
            document.getElementById('sshModal').style.display = 'block';
            
            if (!term) {
                term = new Terminal({ cursorBlink: true, theme: { background: '#000' } });
                fitAddon = new FitAddon.FitAddon();
                term.loadAddon(fitAddon);
                term.open(document.getElementById('terminal-container'));
            }
            setTimeout(() => fitAddon.fit(), 100);
            term.reset();
            term.writeln('Welcome to Web SSH Terminal.');
            
            if(host) {
                term.writeln('\\x1b[36m✨ 探针已上报通信IP，正在尝试全自动直连...\\x1b[0m');
                setTimeout(connectSsh, 500);
            }
        }
        function closeSshModal() {
            document.getElementById('sshModal').style.display = 'none';
            if (ws && ws.readyState === WebSocket.OPEN) ws.close();
        }
        function connectSsh() {
            const serverId = document.getElementById('sshServerId').value;
            const host = document.getElementById('sshHost').value;
            const port = document.getElementById('sshPort').value;
            const username = document.getElementById('sshUser').value;
            const password = document.getElementById('sshPass').value;
            
            if (ws) ws.close();
            term.reset();
            term.writeln('\\x1b[33mConnecting...\\x1b[0m');
            const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
            ws = new WebSocket(protocol + '//' + location.host + '/ssh');
            ws.onopen = () => {
                ws.send(JSON.stringify({ type: 'connect', serverId, host, port, username, password }));
                term.onData(data => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'data', data })); });
            };
            ws.onmessage = (event) => {
                const msg = JSON.parse(event.data);
                if (msg.type === 'data') term.write(msg.data);
                else if (msg.type === 'status') term.write(msg.msg);
                else if (msg.type === 'error') term.write('\\x1b[31m' + msg.msg + '\\x1b[0m');
            };
            ws.onclose = () => { term.writeln('\\r\\n\\x1b[31mConnection closed.\\x1b[0m'); };
        }
        function sendCmd(cmd) {
            if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ type: 'data', data: cmd })); term.focus(); } 
            else { alert('请先连接服务器！'); }
        }
      </script>
    </body>
    </html>`);
});

// ==========================================
// 前台与探针接口
// ==========================================
app.get('/', (req, res) => {
    const sys = getSysSettings();
    if (sys.is_public !== 'true' && !checkWebAuth(req)) return res.redirect('/auth/github'); 

    const viewId = req.query.id;
    if (viewId) {
        const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(viewId);
        if (!server) return res.status(404).send('Server not found');
        return res.send(`<!DOCTYPE html>
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
              <div class="chart-card">
                <h3>国内延迟 <span class="chart-val" style="font-size:12px; font-weight:normal;">电信 <b id="t-ct">0</b> | 联通 <b id="t-cu">0</b> | 移动 <b id="t-cm">0</b> | 字节 <b id="t-bd">0</b></span></h3>
                <canvas id="chartPing"></canvas>
              </div>
              <div class="chart-card"><h3>磁盘 <span class="chart-val" id="text-disk">0%</span></h3><div style="width:100%; height:20px; background:#e5e7eb; border-radius:10px; overflow:hidden; margin-top:40px;"><div id="disk-bar" style="height:100%; width:0%; background:#34d399; transition:width 0.5s;"></div></div><p style="text-align:right; font-size:12px; color:#6b7280; margin-top:8px;" id="text-disk-detail">0 / 0</p></div>
              <div class="chart-card"><h3>进程数 <span class="chart-val" id="text-proc">0</span></h3><canvas id="chartProc"></canvas></div>
              <div class="chart-card"><h3>网络速度 <span class="chart-val" style="font-size:14px;"><span style="color:#10b981">↓</span> <span id="text-net-in">0</span> | <span style="color:#3b82f6">↑</span> <span id="text-net-out">0</span></span></h3><canvas id="chartNet"></canvas></div>
              <div class="chart-card"><h3>TCP / UDP <span class="chart-val" style="font-size:14px;">TCP <span id="text-tcp">0</span> | UDP <span id="text-udp">0</span></span></h3><canvas id="chartConn"></canvas></div>
            </div>
          </div>
          <script>
            const serverId = "${viewId}";
            const formatBytes = (bytes) => { const b = parseInt(bytes); if (isNaN(b) || b === 0) return '0 B'; const k = 1024; const sizes = ['B', 'KB', 'MB', 'GB', 'TB']; const i = Math.floor(Math.log(b) / Math.log(k)); return parseFloat((b / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]; };
            const commonOptions = { responsive: true, maintainAspectRatio: false, animation: { duration: 0 }, scales: { x: { display: false }, y: { beginAtZero: true, border: { display: false } } }, plugins: { legend: { display: false }, tooltip: { enabled: false } }, elements: { point: { radius: 0 }, line: { tension: 0.4, borderWidth: 2 } } };
            const createChart = (ctxId, color, bgColor) => { const ctx = document.getElementById(ctxId).getContext('2d'); return new Chart(ctx, { type: 'line', data: { labels: Array(30).fill(''), datasets: [{ data: Array(30).fill(0), borderColor: color, backgroundColor: bgColor, fill: true }] }, options: commonOptions }); };
            
            const charts = { cpu: createChart('chartCPU', '#3b82f6', 'rgba(59, 130, 246, 0.1)'), ram: createChart('chartRAM', '#8b5cf6', 'rgba(139, 92, 246, 0.1)'), proc: createChart('chartProc', '#ec4899', 'rgba(236, 72, 153, 0.1)') };
            const ctxNet = document.getElementById('chartNet').getContext('2d'); charts.net = new Chart(ctxNet, { type: 'line', data: { labels: Array(30).fill(''), datasets: [ { label: 'In', data: Array(30).fill(0), borderColor: '#10b981', borderWidth: 2, tension: 0.4, pointRadius: 0 }, { label: 'Out', data: Array(30).fill(0), borderColor: '#3b82f6', borderWidth: 2, tension: 0.4, pointRadius: 0 } ]}, options: commonOptions });
            const ctxConn = document.getElementById('chartConn').getContext('2d'); charts.conn = new Chart(ctxConn, { type: 'line', data: { labels: Array(30).fill(''), datasets: [ { label: 'TCP', data: Array(30).fill(0), borderColor: '#6366f1', borderWidth: 2, tension: 0.4, pointRadius: 0 }, { label: 'UDP', data: Array(30).fill(0), borderColor: '#d946ef', borderWidth: 2, tension: 0.4, pointRadius: 0 } ]}, options: commonOptions });
            const ctxPing = document.getElementById('chartPing').getContext('2d'); charts.ping = new Chart(ctxPing, { type: 'line', data: { labels: Array(30).fill(''), datasets: [ { label: '电信', data: Array(30).fill(0), borderColor: '#10b981', borderWidth: 2, tension: 0.4, pointRadius: 0 }, { label: '联通', data: Array(30).fill(0), borderColor: '#f59e0b', borderWidth: 2, tension: 0.4, pointRadius: 0 }, { label: '移动', data: Array(30).fill(0), borderColor: '#3b82f6', borderWidth: 2, tension: 0.4, pointRadius: 0 }, { label: '字节', data: Array(30).fill(0), borderColor: '#8b5cf6', borderWidth: 2, tension: 0.4, pointRadius: 0 } ] }, options: commonOptions });

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
                
                document.getElementById('t-ct').innerText = data.ping_ct + 'ms'; document.getElementById('t-cu').innerText = data.ping_cu + 'ms'; document.getElementById('t-cm').innerText = data.ping_cm + 'ms'; document.getElementById('t-bd').innerText = data.ping_bd + 'ms';

                updateChartData(charts.cpu, parseFloat(data.cpu) || 0); updateChartData(charts.ram, parseFloat(data.ram) || 0); updateChartData(charts.proc, parseInt(data.processes) || 0); updateChartData(charts.net, parseFloat(data.net_in_speed) || 0, 0); updateChartData(charts.net, parseFloat(data.net_out_speed) || 0, 1); updateChartData(charts.conn, parseInt(data.tcp_conn) || 0, 0); updateChartData(charts.conn, parseInt(data.udp_conn) || 0, 1);
                updateChartData(charts.ping, parseInt(data.ping_ct) || 0, 0); updateChartData(charts.ping, parseInt(data.ping_cu) || 0, 1); updateChartData(charts.ping, parseInt(data.ping_cm) || 0, 2); updateChartData(charts.ping, parseInt(data.ping_bd) || 0, 3);
              } catch (e) {}
            }
            setInterval(fetchData, 2000); fetchData();
          </script>
        </body>
        </html>`);
    }

    const results = db.prepare('SELECT * FROM servers').all();
    const now = Date.now();
    let globalOnline = 0; let globalOffline = 0; let globalSpeedIn = 0; let globalSpeedOut = 0; let globalNetTx = 0; let globalNetRx = 0;
    const groups = {};

    if (results && results.length > 0) {
        for (const server of results) {
            const isOnline = (now - server.last_updated) < 30000;
            if (isOnline) { globalOnline++; globalSpeedIn += parseFloat(server.net_in_speed) || 0; globalSpeedOut += parseFloat(server.net_out_speed) || 0; } else globalOffline++;
            globalNetTx += parseFloat(server.net_tx) || 0; globalNetRx += parseFloat(server.net_rx) || 0;
            const grpName = server.server_group || '默认分组';
            if (!groups[grpName]) groups[grpName] = [];
            groups[grpName].push(server);
        }
    }

    const getColor = (ping) => {
        const p = parseInt(ping);
        if (p === 0 || isNaN(p)) return '#9ca3af'; 
        if (p < 100) return '#10b981'; 
        if (p < 200) return '#f59e0b'; 
        return '#ef4444'; 
    };

    let contentHtml = '';
    if (Object.keys(groups).length === 0) contentHtml = '<p style="text-align:center; width: 100%; color:#888;">暂无服务器，请在后台添加</p>';
    else {
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
                if (sys.show_price === 'true') metaHtml += `<div class="card-meta" style="margin-top:8px;">价格: ${server.price || '免费'}</div>`;
                if (sys.show_expire === 'true') {
                    let expireText = '永久';
                    if (server.expire_date) {
                        const diff = new Date(server.expire_date).getTime() - now;
                        expireText = diff > 0 ? Math.ceil(diff / (1000 * 3600 * 24)) + ' 天' : '已过期';
                    }
                    metaHtml += `<div class="card-meta" style="${sys.show_price !== 'true' ? 'margin-top:8px;' : ''}">剩余天数: ${expireText}</div>`;
                }

                let badgesHtml = '';
                if (sys.show_bw === 'true' && server.bandwidth) badgesHtml += `<span class="badge badge-bw">${server.bandwidth}</span>`;
                if (sys.show_tf === 'true' && server.traffic_limit) badgesHtml += `<span class="badge badge-tf">${server.traffic_limit}</span>`;
                if (server.ip_v4 === '1') badgesHtml += `<span class="badge badge-v4">IPv4</span>`;
                if (server.ip_v6 === '1') badgesHtml += `<span class="badge badge-v6">IPv6</span>`;

                const pingHtml = `
                    <div class="ping-box">
                        <span>电信 <span style="color:${getColor(server.ping_ct)}; font-weight:bold;">${server.ping_ct === '0' ? '超时' : server.ping_ct + 'ms'}</span></span>
                        <span>联通 <span style="color:${getColor(server.ping_cu)}; font-weight:bold;">${server.ping_cu === '0' ? '超时' : server.ping_cu + 'ms'}</span></span>
                        <span>移动 <span style="color:${getColor(server.ping_cm)}; font-weight:bold;">${server.ping_cm === '0' ? '超时' : server.ping_cm + 'ms'}</span></span>
                        <span>字节 <span style="color:${getColor(server.ping_bd)}; font-weight:bold;">${server.ping_bd === '0' ? '超时' : server.ping_bd + 'ms'}</span></span>
                    </div>
                `;

                contentHtml += `
                    <a href="/?id=${server.id}" class="vps-card">
                        <div class="card-left"><div class="card-title"><div class="status-dot" style="background:${statusColor};"></div>${flagHtml} <span style="font-size:15px;" class="card-title-text">${server.name}</span></div>${metaHtml}<div class="card-badges">${badgesHtml}</div>${pingHtml}</div>
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

    res.send(`<!DOCTYPE html>
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
    </html>`);
});

// 安全分发主控端公钥接口
app.get('/update-pubkey', (req, res) => {
    res.setHeader('Content-Type', 'text/plain;charset=UTF-8');
    res.send(MASTER_PUBLIC_KEY);
});

// ==========================================
// 终极点火脚本：集成 Zero Trust 自动组网与公钥拉取
// ==========================================
app.get('/install.sh', (req, res) => {
    const host = `${req.protocol}://${req.get('host')}`;
    const teamName = process.env.CF_TEAM_NAME || '';
    const clientId = process.env.CF_CLIENT_ID || '';
    const clientSecret = process.env.CF_CLIENT_SECRET || '';

    const bashScript = `#!/bin/bash
SERVER_ID=\$1
SECRET=\$2
WORKER_URL="${host}/update"

if [ -z "\$SERVER_ID" ] || [ -z "\$SECRET" ]; then echo "错误: 缺少参数。"; exit 1; fi

echo "=================================================="
echo "🚀 开始安装探针 Agent 及 Zero Trust 军工级暗网组件"
echo "=================================================="

systemctl stop cf-probe.service 2>/dev/null
pkill -f cf-probe.sh 2>/dev/null

# ==========================================
# 阶段 1: 从主控面板安全拉取公钥并注入，开启无密秒连
# ==========================================
echo "正在拉取并注入面板控制公钥..."
MASTER_PUB_KEY=\$(curl -sL "${host}/update-pubkey")
if [ -n "\$MASTER_PUB_KEY" ]; then
    mkdir -p ~/.ssh
    chmod 700 ~/.ssh
    if ! grep -q "\$MASTER_PUB_KEY" ~/.ssh/authorized_keys 2>/dev/null; then
        echo "\$MASTER_PUB_KEY" >> ~/.ssh/authorized_keys
        chmod 600 ~/.ssh/authorized_keys
        echo "✅ 安全公钥注入成功！"
    fi
fi

# 抓取真实 SSH 端口
SSH_PORT=\$(sshd -T 2>/dev/null | awk '/^port /{print \$2}' | head -n1)
SSH_PORT=\${SSH_PORT:-22}

# ==========================================
# 阶段 2: 注入 Cloudflare Zero Trust 自动化组件
# ==========================================
ZT_IP=""
if [ -n "${teamName}" ] && [ -n "${clientId}" ]; then
    if ! command -v warp-cli &> /dev/null; then
        echo "📦 正在安装 Cloudflare WARP 官方客户端..."
        curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg | sudo gpg --yes --dearmor --output /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg
        echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ \$(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/cloudflare-client.list
        sudo apt-get update && sudo apt-get install cloudflare-warp -y
    fi

    echo "🔐 正在注入 Zero Trust MDM 凭据并组网..."
    mkdir -p /var/lib/cloudflare-warp
    cat << 'EOFMDM' > /var/lib/cloudflare-warp/mdm.xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>organization</key>
  <string>${teamName}</string>
  <key>auth_client_id</key>
  <string>${clientId}</string>
  <key>auth_client_secret</key>
  <string>${clientSecret}</string>
</dict>
</plist>
EOFMDM

    systemctl restart warp-svc
    sleep 5
    warp-cli --accept-tos connect
    sleep 5
    
    ZT_IP=\$(ip -6 addr show CloudflareWARP 2>/dev/null | grep inet6 | grep -v fe80 | awk '{print \$2}' | cut -d/ -f1 | head -n1)
    
    if [ -z "\$ZT_IP" ]; then
        echo "⚠️ 警告: 未能获取到 Zero Trust 内网 IP，请检查面板环境变量配置。"
    else
        echo "✅ 成功加入私有网络！分配内网 IP: \$ZT_IP"
    fi
fi

# ==========================================
# 阶段 3: 写入主探针脚本
# ==========================================
cat << 'EOF' > /usr/local/bin/cf-probe.sh
#!/bin/bash
SERVER_ID="\$1"
SECRET="\$2"
WORKER_URL="\$3"
SSH_PORT="\$4"
ZT_IP="\$5"

get_net_bytes() { awk 'NR>2 {rx+=\$2; tx+=\$10} END {printf "%.0f %.0f", rx, tx}' /proc/net/dev; }
get_cpu_stat() { awk '/^cpu / {print \$2+\$3+\$4+\$5+\$6+\$7+\$8+\$9, \$5+\$6}' /proc/stat; }

CT_NODES=("bj-ct-dualstack.ip.zstaticcdn.com" "sh-ct-dualstack.ip.zstaticcdn.com" "gd-ct-dualstack.ip.zstaticcdn.com")
CU_NODES=("bj-cu-dualstack.ip.zstaticcdn.com" "sh-cu-dualstack.ip.zstaticcdn.com" "gd-cu-dualstack.ip.zstaticcdn.com")
CM_NODES=("bj-cm-dualstack.ip.zstaticcdn.com" "sh-cm-dualstack.ip.zstaticcdn.com" "gd-cm-dualstack.ip.zstaticcdn.com")

get_http_ping() {
  local rtt=\$(curl -o /dev/null -s -m 2 -w "%{time_total}" "http://\$1" 2>/dev/null | awk '{printf "%.0f", \$1*1000}')
  echo "\${rtt:-0}"
}

NET_STAT=\$(get_net_bytes)
RX_PREV=\$(echo \$NET_STAT | awk '{print \$1}')
TX_PREV=\$(echo \$NET_STAT | awk '{print \$2}')
if [ -z "\$RX_PREV" ]; then RX_PREV=0; fi
if [ -z "\$TX_PREV" ]; then TX_PREV=0; fi

CPU_STAT=\$(get_cpu_stat)
PREV_CPU_TOTAL=\$(echo \$CPU_STAT | awk '{print \$1}')
PREV_CPU_IDLE=\$(echo \$CPU_STAT | awk '{print \$2}')

LOOP_COUNT=0
IPV4="0"; IPV6="0"
PING_CT="0"; PING_CU="0"; PING_CM="0"; PING_BD="0"
BEST_IP=""

while true; do
  if [ \$((LOOP_COUNT % 60)) -eq 0 ]; then
    curl -s -4 -m 3 https://cloudflare.com/cdn-cgi/trace 2>/dev/null | grep -q "ip=" && IPV4="1" || IPV4="0"
    curl -s -6 -m 3 https://cloudflare.com/cdn-cgi/trace 2>/dev/null | grep -q "ip=" && IPV6="1" || IPV6="0"
  fi
  
  if [ \$((LOOP_COUNT % 6)) -eq 0 ]; then
    PING_CT=\$(get_http_ping "\${CT_NODES[\$RANDOM % \${#CT_NODES[@]}]}")
    PING_CU=\$(get_http_ping "\${CU_NODES[\$RANDOM % \${#CU_NODES[@]}]}")
    PING_CM=\$(get_http_ping "\${CM_NODES[\$RANDOM % \${#CM_NODES[@]}]}")
    PING_BD=\$(get_http_ping "lf3-ips.zstaticcdn.com")
    
    # IP 选用逻辑：如果有 Zero Trust 内网 IP，最高优先级！其次是真实公网
    REAL_IPV4=\$(curl -s4 -m 3 https://cloudflare.com/cdn-cgi/trace 2>/dev/null | awk -F= '/ip=/{print \$2}')
    REAL_IPV6=\$(curl -s6 -m 3 https://cloudflare.com/cdn-cgi/trace 2>/dev/null | awk -F= '/ip=/{print \$2}')
    BEST_IP="\${ZT_IP:-\${REAL_IPV4:-\$REAL_IPV6}}"
  fi

  LOOP_COUNT=\$((LOOP_COUNT + 1))

  OS=\$(awk -F= '/^PRETTY_NAME/{print \$2}' /etc/os-release | tr -d '"')
  if [ -z "\$OS" ]; then OS=\$(uname -srm); fi
  ARCH=\$(uname -m)
  BOOT_TIME=\$(uptime -s 2>/dev/null || stat -c %y / 2>/dev/null | cut -d'.' -f1 || echo "Unknown")
  CPU_INFO=\$(grep -m 1 'model name' /proc/cpuinfo | awk -F: '{print \$2}' | xargs | tr -d '"')
  
  CPU_STAT=\$(get_cpu_stat)
  CPU_TOTAL=\$(echo \$CPU_STAT | awk '{print \$1}')
  CPU_IDLE=\$(echo \$CPU_STAT | awk '{print \$2}')
  DIFF_TOTAL=\$((CPU_TOTAL - PREV_CPU_TOTAL))
  DIFF_IDLE=\$((CPU_IDLE - PREV_CPU_IDLE))
  CPU=\$(awk -v t=\$DIFF_TOTAL -v i=\$DIFF_IDLE 'BEGIN {if (t==0) print 0; else printf "%.2f", (1 - i/t)*100}')
  PREV_CPU_TOTAL=\$CPU_TOTAL; PREV_CPU_IDLE=\$CPU_IDLE
  
  MEM_INFO=\$(free -m)
  RAM_TOTAL=\$(echo "\$MEM_INFO" | awk '/Mem:/ {print \$2}')
  RAM_USED=\$(echo "\$MEM_INFO" | awk '/Mem:/ {print \$3}')
  RAM=\$(awk "BEGIN {if(\$RAM_TOTAL>0) printf \\"%.2f\\", \$RAM_USED/\$RAM_TOTAL * 100.0; else print 0}")
  
  SWAP_TOTAL=\$(echo "\$MEM_INFO" | awk '/Swap:/ {print \$2}')
  SWAP_USED=\$(echo "\$MEM_INFO" | awk '/Swap:/ {print \$3}')
  if [ -z "\$SWAP_TOTAL" ]; then SWAP_TOTAL=0; fi
  if [ -z "\$SWAP_USED" ]; then SWAP_USED=0; fi

  DISK_INFO=\$(df -hm / | tail -n1 | awk '{print \$2, \$3, \$5}')
  DISK_TOTAL=\$(echo "\$DISK_INFO" | awk '{print \$1}')
  DISK_USED=\$(echo "\$DISK_INFO" | awk '{print \$2}')
  DISK=\$(echo "\$DISK_INFO" | awk '{print \$3}' | tr -d '%')

  LOAD=\$(cat /proc/loadavg | awk '{print \$1, \$2, \$3}')
  UPTIME=\$(uptime -p | sed 's/up //')
  
  PROCESSES=\$(ps -e | wc -l)
  TCP_CONN=\$(ss -ant 2>/dev/null | grep -v State | wc -l || netstat -ant 2>/dev/null | grep -v Active | wc -l)
  UDP_CONN=\$(ss -anu 2>/dev/null | grep -v State | wc -l || netstat -anu 2>/dev/null | grep -v Active | wc -l)
  
  NET_STAT=\$(get_net_bytes)
  RX_NOW=\$(echo \$NET_STAT | awk '{print \$1}')
  TX_NOW=\$(echo \$NET_STAT | awk '{print \$2}')
  if [ -z "\$RX_NOW" ]; then RX_NOW=0; fi
  if [ -z "\$TX_NOW" ]; then TX_NOW=0; fi

  RX_SPEED=\$(((RX_NOW - RX_PREV) / 5))
  TX_SPEED=\$(((TX_NOW - TX_PREV) / 5))
  RX_PREV=\$RX_NOW; TX_PREV=\$TX_NOW
  
  PAYLOAD="{\\"id\\": \\"\$SERVER_ID\\", \\"secret\\": \\"\$SECRET\\", \\"ssh_host\\": \\"\$BEST_IP\\", \\"ssh_port\\": \\"\$SSH_PORT\\", \\"metrics\\": { \\"cpu\\": \\"\$CPU\\", \\"ram\\": \\"\$RAM\\", \\"ram_total\\": \\"\$RAM_TOTAL\\", \\"ram_used\\": \\"\$RAM_USED\\", \\"swap_total\\": \\"\$SWAP_TOTAL\\", \\"swap_used\\": \\"\$SWAP_USED\\", \\"disk\\": \\"\$DISK\\", \\"disk_total\\": \\"\$DISK_TOTAL\\", \\"disk_used\\": \\"\$DISK_USED\\", \\"load\\": \\"\$LOAD\\", \\"uptime\\": \\"\$UPTIME\\", \\"boot_time\\": \\"\$BOOT_TIME\\", \\"net_rx\\": \\"\$RX_NOW\\", \\"net_tx\\": \\"\$TX_NOW\\", \\"net_in_speed\\": \\"\$RX_SPEED\\", \\"net_out_speed\\": \\"\$TX_SPEED\\", \\"os\\": \\"\$OS\\", \\"arch\\": \\"\$ARCH\\", \\"cpu_info\\": \\"\$CPU_INFO\\", \\"processes\\": \\"\$PROCESSES\\", \\"tcp_conn\\": \\"\$TCP_CONN\\", \\"udp_conn\\": \\"\$UDP_CONN\\", \\"ip_v4\\": \\"\$IPV4\\", \\"ip_v6\\": \\"\$IPV6\\", \\"ping_ct\\": \\"\$PING_CT\\", \\"ping_cu\\": \\"\$PING_CU\\", \\"ping_cm\\": \\"\$PING_CM\\", \\"ping_bd\\": \\"\$PING_BD\\" }}"
  
  curl -s -X POST -H "Content-Type: application/json" -d "\$PAYLOAD" "$WORKER_URL" > /dev/null
  sleep 5
done
EOF

cat << 'EOF' > /usr/local/bin/cf-ip-check.sh
#!/bin/bash
SERVER_ID="$1"
SECRET="$2"
WORKER_URL="$3"

if ! command -v curl &> /dev/null; then exit 1; fi
REPORT=\$(curl -sL https://raw.githubusercontent.com/xykt/IPQuality/main/ip.sh | bash)
REPORT_B64=\$(echo "\$REPORT" | base64 | tr -d '\\n' | tr -d '\\r')

PAYLOAD="{\\"id\\": \\"$SERVER_ID\\", \\"secret\\": \\"$SECRET\\", \\"report_b64\\": \\"\$REPORT_B64\\"}"
curl -s -X POST -H "Content-Type: application/json" -d "\$PAYLOAD" "$WORKER_URL" > /dev/null
EOF

cat << 'EOF' > /usr/local/bin/cf-ip-warm.sh
#!/bin/bash
echo -e "\\e[33m[IP 养护] 正在初始化原生防送中探测序列...\\e[0m"
UAS=(
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15"
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
)
KEYWORDS=("weather" "local+news" "amazon" "netflix" "speedtest" "restaurant+near+me" "buy+shoes+online" "maps")
RAND_UA=\${UAS[\$RANDOM % \${#UAS[@]}]}
RAND_KW=\${KEYWORDS[\$RANDOM % \${#KEYWORDS[@]}]}

curl -sL -A "\$RAND_UA" -H "Accept-Language: en-US,en;q=0.9" "https://www.google.com/search?q=\$RAND_KW" > /dev/null
sleep \$((RANDOM % 5 + 2))
curl -sL -A "\$RAND_UA" "https://www.youtube.com/results?search_query=\$RAND_KW" > /dev/null
echo -e "\\e[32m[IP 养护] 探测完成，已成功向全球数据库注入活跃本地信号！\\e[0m"
EOF

chmod +x /usr/local/bin/cf-probe.sh
chmod +x /usr/local/bin/cf-ip-check.sh
chmod +x /usr/local/bin/cf-ip-warm.sh

cat << EOF > /etc/systemd/system/cf-probe.service
[Unit]
Description=Server Monitor Probe Agent
After=network.target

[Service]
ExecStart=/usr/local/bin/cf-probe.sh $SERVER_ID $SECRET $WORKER_URL \$SSH_PORT \$ZT_IP
Restart=always
User=root

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable cf-probe.service
systemctl restart cf-probe.service

RAND_MIN=\$((RANDOM % 60))
(crontab -l 2>/dev/null | grep -v "cf-ip-check.sh" | grep -v "cf-ip-warm.sh" ; echo "\$RAND_MIN 4 * * * /usr/local/bin/cf-ip-check.sh $SERVER_ID $SECRET ${host}/update-ip" ; echo "\$RAND_MIN */6 * * * /usr/local/bin/cf-ip-warm.sh > /dev/null 2>&1") | crontab -

nohup /usr/local/bin/cf-ip-check.sh $SERVER_ID $SECRET "${host}/update-ip" > /dev/null 2>&1 &

echo "✅ 探针及军工级增强模块安装成功！打开面板即可零配置秒连！"
`;
    res.setHeader('Content-Type', 'text/plain;charset=UTF-8');
    res.send(bashScript);
});

app.post('/update', (req, res) => {
    try {
        const { id, secret, ssh_host, ssh_port, metrics } = req.body;
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
              country = ?, ip_v4 = ?, ip_v6 = ?, ping_ct = ?, ping_cu = ?, ping_cm = ?, ping_bd = ?,
              ssh_host = ?, ssh_port = ?
          WHERE id = ?
        `).run(
          metrics.cpu, metrics.ram, metrics.disk, metrics.load, metrics.uptime, Date.now(),
          metrics.ram_total || '0', metrics.net_rx || '0', metrics.net_tx || '0', 
          metrics.net_in_speed || '0', metrics.net_out_speed || '0', 
          metrics.os || '', metrics.cpu_info || '', metrics.arch || '', metrics.boot_time || '',
          metrics.ram_used || '0', metrics.swap_total || '0', metrics.swap_used || '0',
          metrics.disk_total || '0', metrics.disk_used || '0', metrics.processes || '0',
          metrics.tcp_conn || '0', metrics.udp_conn || '0', countryCode, 
          metrics.ip_v4 || '0', metrics.ip_v6 || '0', 
          metrics.ping_ct || '0', metrics.ping_cu || '0', metrics.ping_cm || '0', metrics.ping_bd || '0', 
          ssh_host || '', ssh_port || '22', id
        );

        checkOfflineNodes().catch(console.error);
        res.status(200).send('OK');
    } catch (e) {
        res.status(400).send('Error');
    }
});

app.post('/update-ip', (req, res) => {
    try {
        const { id, secret, report_b64 } = req.body;
        if (secret !== API_SECRET) return res.status(401).send('Unauthorized');
        const reportText = Buffer.from(report_b64, 'base64').toString('utf-8');
        db.prepare('INSERT INTO ip_reports (id, server_id, created_at, report_text) VALUES (?, ?, ?, ?)').run(crypto.randomUUID(), id, Date.now(), reportText);
        db.prepare(`DELETE FROM ip_reports WHERE id NOT IN (SELECT id FROM ip_reports WHERE server_id = ? ORDER BY created_at DESC LIMIT 30) AND server_id = ?`).run(id, id);
        res.status(200).send('OK');
    } catch (e) { res.status(400).send('Error'); }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server Monitor Pro (Node Edition) running on port ${PORT}`);
    console.log(`Database mounted at ${DB_PATH}`);
});
