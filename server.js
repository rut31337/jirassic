const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { WebSocketServer } = require("ws");

const PORT = 31337;
const SCRIPT_DIR = __dirname;
const STATE_DIR = path.join(process.env.HOME, ".config", "daily-triage");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const CACHE_FILE = path.join(STATE_DIR, "cache.json");
const PYTHON = "python3";
const JIRA_SITE = process.env.JIRA_SITE || "redhat.atlassian.net";

fs.mkdirSync(STATE_DIR, { recursive: true });

// --- State management ---

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { triaged: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function saveCache(data) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data));
}

function itemHash(text) {
  return crypto
    .createHash("sha256")
    .update(text.trim())
    .digest("hex")
    .slice(0, 16);
}

// --- Data fetching ---

function runScript(name, args = []) {
  return new Promise((resolve) => {
    execFile(
      PYTHON,
      [path.join(SCRIPT_DIR, name), ...args],
      { env: { ...process.env }, timeout: 120000 },
      (err, stdout, stderr) => {
        if (err) {
          console.error(`${name} error:`, stderr || err.message);
          resolve([]);
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve([]);
        }
      }
    );
  });
}

async function fetchAllData() {
  const project = process.env.TRIAGE_PROJECT || "";
  const days = process.env.TRIAGE_DAYS || "7";

  const [actionItems, tickets] = await Promise.all([
    runScript("my-action-items", ["--json", days]),
    runScript("my-jira-tickets", [
      "--json",
      ...(project ? ["--project", project] : []),
    ]),
  ]);

  const data = buildData(actionItems, tickets);
  saveCache(data);
  return data;
}

function buildData(actionItems, tickets) {
  const state = loadState();

  const allItems = [];
  for (const meeting of actionItems) {
    for (const text of meeting.items) {
      const h = itemHash(text);
      allItems.push({
        hash: h,
        meeting: meeting.meeting,
        date: meeting.date,
        text,
        triaged: state.triaged[h] || null,
      });
    }
  }

  const newItems = allItems.filter((i) => !i.triaged);
  const triagedItems = allItems.filter((i) => i.triaged);

  for (const [h, info] of Object.entries(state.triaged)) {
    if (!allItems.find((i) => i.hash === h)) {
      triagedItems.push({
        hash: h,
        meeting: info.meeting || "",
        date: "",
        text: info.text || "",
        triaged: info,
      });
    }
  }

  const sprintTickets = tickets.filter((t) => t.sprint);
  const sprintName = sprintTickets[0]?.sprint || "";

  let lastSprintName = "";
  for (const t of tickets) {
    if (t.last_sprint) {
      lastSprintName = t.last_sprint;
      break;
    }
  }
  const lastSprintTickets = lastSprintName
    ? tickets.filter((t) => t.last_sprint === lastSprintName)
    : [];

  const backlogTickets = tickets.filter(
    (t) => !t.sprint && !t.last_sprint
  );

  return {
    newItems,
    triagedItems,
    tickets,
    sprintTickets,
    sprintName,
    lastSprintTickets,
    lastSprintName,
    backlogTickets,
    updated: new Date().toISOString(),
  };
}

// --- WebSocket ---

const wss = new WebSocketServer({ noServer: true });
const clients = new Set();

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

// --- HTTP Server ---

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
  });
}

const server = http.createServer(async (req, res) => {
  const json = (data, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };

  if (req.method === "GET" && req.url === "/api/data") {
    // Serve cache immediately, refresh in background
    const cached = loadCache();
    if (cached) {
      json(cached);
    } else {
      json(await fetchAllData());
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/refresh") {
    const data = await fetchAllData();
    broadcast({ type: "refresh", data });
    json({ ok: true });
    return;
  }

  if (req.method === "POST" && req.url === "/api/triage") {
    try {
      const { hash, status, ticket, text, meeting } = JSON.parse(
        await readBody(req)
      );
      const state = loadState();
      state.triaged[hash] = {
        text,
        meeting,
        status,
        ...(ticket ? { ticket } : {}),
        triaged: new Date().toISOString(),
      };
      saveState(state);
      // Rebuild from cache with new state
      const cached = loadCache();
      if (cached) {
        // Re-derive from raw data isn't possible without re-fetching,
        // so just re-fetch — it's fast since scripts are local
        const data = await fetchAllData();
        broadcast({ type: "refresh", data });
      }
      json({ ok: true });
    } catch (e) {
      json({ error: e.message }, 400);
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/untriage") {
    try {
      const { hash } = JSON.parse(await readBody(req));
      const state = loadState();
      delete state.triaged[hash];
      saveState(state);
      const data = await fetchAllData();
      broadcast({ type: "refresh", data });
      json({ ok: true });
    } catch (e) {
      json({ error: e.message }, 400);
    }
    return;
  }

  if (req.method === "GET" && req.url === "/favicon.ico") {
    const faviconPath = path.join(SCRIPT_DIR, "favicon.ico");
    try {
      const data = fs.readFileSync(faviconPath);
      res.writeHead(200, { "Content-Type": "image/x-icon", "Cache-Control": "public, max-age=86400" });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end();
    }
    return;
  }

  if (
    req.method === "GET" &&
    (req.url === "/" || req.url === "/index.html")
  ) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(getDashboardHTML());
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

// --- Dashboard HTML ---

function getDashboardHTML() {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Daily Triage Dashboard</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #c9d1d9; padding: 2rem; }
    h1 { color: #f0f6fc; margin-bottom: 0.5rem; }
    .header { display: flex; align-items: center; gap: 1rem; margin-bottom: 0.5rem; }
    .updated { color: #8b949e; font-size: 0.9rem; margin-bottom: 2rem; }
    .refresh-btn { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; padding: 4px 12px; border-radius: 6px; cursor: pointer; font-size: 0.85rem; }
    .refresh-btn:hover { background: #30363d; }
    .refresh-btn.loading { opacity: 0.5; cursor: wait; }
    .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
    .status-dot.connected { background: #238636; }
    .status-dot.disconnected { background: #da3633; }
    h2 { color: #f0f6fc; margin: 2rem 0 1rem; border-bottom: 1px solid #30363d; padding-bottom: 0.5rem; }
    h3 { color: #c9d1d9; margin: 1.5rem 0 0.5rem; font-size: 0.95rem; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 1rem; }
    th { text-align: left; padding: 0.5rem; color: #8b949e; border-bottom: 1px solid #30363d; font-size: 0.85rem; }
    td { padding: 0.5rem; border-bottom: 1px solid #21262d; font-size: 0.9rem; }
    tr:hover { background: #161b22; }
    .epic-row { background: #161b22; }
    a { color: #58a6ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: 600; }
    .badge.new { background: #da3633; color: #fff; }
    .badge.jira { background: #1f6feb; color: #fff; }
    .badge.skip { background: #30363d; color: #8b949e; }
    .badge.done { background: #238636; color: #fff; }
    .badge.status-in-progress { background: #1f6feb; color: #fff; }
    .badge.status-new { background: #6e7681; color: #fff; }
    .badge.status-to-do { background: #e3b341; color: #000; }
    .badge.status-backlog { background: #30363d; color: #8b949e; }
    .badge.status-release-pending { background: #a371f7; color: #fff; }
    .empty { color: #8b949e; padding: 1rem; text-align: center; }
    .tabs { display: flex; gap: 0; }
    .tab { padding: 0.6rem 1.2rem; cursor: pointer; border: 1px solid #30363d; border-bottom: none; border-radius: 6px 6px 0 0; background: #161b22; color: #8b949e; font-size: 0.9rem; }
    .tab.active { background: #0d1117; color: #f0f6fc; border-bottom: 1px solid #0d1117; }
    .tab-content { display: none; border: 1px solid #30363d; border-radius: 0 6px 6px 6px; padding: 1rem; }
    .tab-content.active { display: block; }
    .toggle { cursor: pointer; user-select: none; }
    .toggle:hover { color: #58a6ff; }
    .arrow { font-size: 0.7rem; margin-left: 0.3rem; }
    .collapsed { display: none; }
    .triage-actions { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
    .triage-btn { padding: 2px 10px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #c9d1d9; cursor: pointer; font-size: 0.8rem; }
    .triage-btn:hover { background: #30363d; }
    .triage-btn.done-btn:hover { background: #238636; color: #fff; }
    .triage-btn.jira-btn:hover { background: #1f6feb; color: #fff; }
    .triage-btn.undo-btn { border-color: #484f58; }
    .triage-btn.undo-btn:hover { background: #da3633; color: #fff; }
    .jira-input { background: #0d1117; border: 1px solid #30363d; color: #c9d1d9; padding: 2px 6px; border-radius: 4px; font-size: 0.8rem; width: 140px; }
    .jira-input::placeholder { color: #484f58; }
    .toast { position: fixed; bottom: 2rem; right: 2rem; background: #238636; color: #fff; padding: 0.5rem 1rem; border-radius: 6px; font-size: 0.9rem; opacity: 0; transition: opacity 0.3s; pointer-events: none; z-index: 100; }
    .toast.show { opacity: 1; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Daily Triage Dashboard</h1>
    <button class="refresh-btn" id="refresh-btn">Refresh Now</button>
    <span><span class="status-dot" id="ws-status"></span><span id="ws-label">connecting</span></span>
  </div>
  <p class="updated" id="updated"></p>
  <div id="app"><p class="empty">Loading...</p></div>
  <div class="toast" id="toast"></div>

  <script>
    const JIRA_SITE = ${JSON.stringify(JIRA_SITE)};
    let DATA = null;
    let activeTab = 'sprint';

    // --- Utilities ---
    function esc(s) {
      if (!s) return '';
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    function jiraLink(key) {
      return '<a href="https://' + esc(JIRA_SITE) + '/browse/' + esc(key) + '" target="_blank">' + esc(key) + '</a>';
    }

    function showToast(msg) {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.classList.add('show');
      setTimeout(() => el.classList.remove('show'), 2000);
    }

    // --- WebSocket ---
    let ws;
    function connectWS() {
      ws = new WebSocket('ws://' + location.host);
      ws.onopen = () => {
        document.getElementById('ws-status').className = 'status-dot connected';
        document.getElementById('ws-label').textContent = 'Local Service Live';
      };
      ws.onclose = () => {
        document.getElementById('ws-status').className = 'status-dot disconnected';
        document.getElementById('ws-label').textContent = 'Local Service Reconnecting...';
        setTimeout(connectWS, 3000);
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'refresh') { DATA = msg.data; render(); }
      };
    }
    connectWS();

    // --- API ---
    document.getElementById('refresh-btn').onclick = async () => {
      const btn = document.getElementById('refresh-btn');
      btn.classList.add('loading');
      btn.textContent = 'Refreshing...';
      await fetch('/api/refresh', { method: 'POST' });
      btn.classList.remove('loading');
      btn.textContent = 'Refresh Now';
    };

    async function triageItem(hash, status, ticketInputId, text, meeting) {
      const ticket = ticketInputId ? document.getElementById(ticketInputId)?.value || '' : '';
      if (status === 'jira' && !ticket) {
        const input = document.getElementById(ticketInputId);
        if (input) { input.focus(); input.style.borderColor = '#da3633'; }
        return;
      }
      await fetch('/api/triage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash, status, ticket, text, meeting }),
      });
      showToast(status === 'skip' ? 'Skipped' : status === 'done' ? 'Marked done' : 'Linked to ' + ticket);
    }

    async function unTriageItem(hash) {
      await fetch('/api/untriage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash }),
      });
      showToast('Moved back to new');
    }

    // --- Tab switching ---
    function switchTab(name) {
      activeTab = name;
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      document.getElementById('tab-' + name)?.classList.add('active');
      document.querySelector('[data-tab="' + name + '"]')?.classList.add('active');
    }

    function toggleCollapse(id, arrowId) {
      document.getElementById(id)?.classList.toggle('collapsed');
      const arrow = document.getElementById(arrowId);
      if (arrow) arrow.textContent = arrow.textContent === '\\u25B6' ? '\\u25BC' : '\\u25B6';
    }

    // --- Render ticket table ---
    function renderTicketTable(tickets) {
      if (!tickets || !tickets.length) return '<p class="empty">No tickets</p>';
      const epicInfo = {}, epicChildren = {}, standalone = [];
      for (const t of tickets) {
        if (t.type === 'Epic') { epicInfo[t.key] = t; epicChildren[t.key] = epicChildren[t.key] || []; }
        else if (t.parent) { epicChildren[t.parent] = epicChildren[t.parent] || []; epicChildren[t.parent].push(t); }
        else standalone.push(t);
      }
      let rows = '';
      for (const [key, children] of Object.entries(epicChildren)) {
        const info = epicInfo[key];
        if (info) {
          const sc = info.status.toLowerCase().replace(/ /g, '-');
          rows += '<tr class="epic-row"><td>' + jiraLink(info.key) + '</td><td><span class="badge status-' + sc + '">' + esc(info.status) + '</span></td><td>' + esc(info.priority) + '</td><td><strong>' + esc(info.summary) + '</strong></td></tr>';
        } else {
          rows += '<tr class="epic-row"><td>' + esc(key) + '</td><td></td><td></td><td><strong>(epic not assigned to you)</strong></td></tr>';
        }
        for (const c of children) {
          const sc = c.status.toLowerCase().replace(/ /g, '-');
          rows += '<tr><td style="padding-left:2rem">' + jiraLink(c.key) + '</td><td><span class="badge status-' + sc + '">' + esc(c.status) + '</span></td><td>' + esc(c.priority) + '</td><td>' + esc(c.summary) + '</td></tr>';
        }
      }
      if (standalone.length) {
        rows += '<tr class="epic-row"><td></td><td></td><td></td><td><strong>Standalone</strong></td></tr>';
        for (const t of standalone) {
          const sc = t.status.toLowerCase().replace(/ /g, '-');
          rows += '<tr><td style="padding-left:2rem">' + jiraLink(t.key) + '</td><td><span class="badge status-' + sc + '">' + esc(t.status) + '</span></td><td>' + esc(t.priority) + '</td><td>' + esc(t.summary) + '</td></tr>';
        }
      }
      return '<table><tr><th>Key</th><th>Status</th><th>Priority</th><th>Summary</th></tr>' + rows + '</table>';
    }

    // --- Main render ---
    function render() {
      if (!DATA) return;
      document.getElementById('updated').textContent = 'Updated: ' + new Date(DATA.updated).toLocaleString();

      const { newItems, triagedItems, sprintTickets, sprintName, lastSprintTickets, lastSprintName, backlogTickets, tickets } = DATA;
      const app = document.getElementById('app');

      let html = '<h2>New Action Items (' + newItems.length + ')</h2>';

      if (newItems.length) {
        html += '<table><tr><th></th><th>Meeting</th><th>Action Item</th><th>Triage</th></tr>';
        for (const item of newItems) {
          const inputId = 'jira-' + item.hash;
          html += '<tr><td><span class="badge new">NEW</span></td>'
            + '<td>' + esc(item.meeting) + '</td>'
            + '<td>' + esc(item.text) + '</td>'
            + '<td><div class="triage-actions">'
            + '<button class="triage-btn skip-btn" data-action="skip" data-hash="' + item.hash + '" data-text="' + esc(item.text) + '" data-meeting="' + esc(item.meeting) + '">Skip</button>'
            + '<button class="triage-btn done-btn" data-action="done" data-hash="' + item.hash + '" data-text="' + esc(item.text) + '" data-meeting="' + esc(item.meeting) + '">Done</button>'
            + '<input class="jira-input" id="' + inputId + '" placeholder="PROJ-123">'
            + '<button class="triage-btn jira-btn" data-action="jira" data-hash="' + item.hash + '" data-input="' + inputId + '" data-text="' + esc(item.text) + '" data-meeting="' + esc(item.meeting) + '">Jira</button>'
            + '</div></td></tr>';
        }
        html += '</table>';
      } else {
        html += '<p class="empty">No new action items</p>';
      }

      // Tickets
      html += '<h2>Jira Tickets</h2><div class="tabs">';
      html += '<div class="tab' + (activeTab === 'sprint' ? ' active' : '') + '" data-tab="sprint">Current: ' + esc(sprintName || 'None') + ' (' + sprintTickets.length + ')</div>';
      html += '<div class="tab' + (activeTab === 'last-sprint' ? ' active' : '') + '" data-tab="last-sprint">Last: ' + esc(lastSprintName || 'None') + ' (' + lastSprintTickets.length + ')</div>';
      html += '<div class="tab' + (activeTab === 'backlog' ? ' active' : '') + '" data-tab="backlog">Backlog (' + backlogTickets.length + ')</div>';
      html += '<div class="tab' + (activeTab === 'all' ? ' active' : '') + '" data-tab="all">All Open (' + tickets.length + ')</div>';
      html += '</div>';
      html += '<div class="tab-content' + (activeTab === 'sprint' ? ' active' : '') + '" id="tab-sprint">' + renderTicketTable(sprintTickets) + '</div>';
      html += '<div class="tab-content' + (activeTab === 'last-sprint' ? ' active' : '') + '" id="tab-last-sprint">' + renderTicketTable(lastSprintTickets) + '</div>';
      html += '<div class="tab-content' + (activeTab === 'backlog' ? ' active' : '') + '" id="tab-backlog">' + renderTicketTable(backlogTickets) + '</div>';
      html += '<div class="tab-content' + (activeTab === 'all' ? ' active' : '') + '" id="tab-all">' + renderTicketTable(tickets) + '</div>';

      // Triaged
      const jiraItems = triagedItems.filter(i => i.triaged?.status === 'jira');
      const skipItems = triagedItems.filter(i => i.triaged?.status !== 'jira');

      html += '<h2><span class="toggle" id="triaged-toggle">Triaged Action Items (' + triagedItems.length + ') <span class="arrow" id="triaged-arrow">\\u25B6</span></span></h2>';
      html += '<div id="triaged-section" class="collapsed">';

      if (jiraItems.length) {
        html += '<h3><span class="toggle" id="jira-toggle">Linked to Jira (' + jiraItems.length + ') <span class="arrow" id="jira-arrow">\\u25B6</span></span></h3>';
        html += '<div id="jira-items" class="collapsed"><table><tr><th>Ticket</th><th>Meeting</th><th>Action Item</th><th></th></tr>';
        for (const i of jiraItems) {
          const ticket = i.triaged.ticket || '';
          html += '<tr><td><span class="badge jira">' + (ticket ? jiraLink(ticket) : 'jira') + '</span></td><td>' + esc(i.meeting) + '</td><td>' + esc(i.text) + '</td><td><button class="triage-btn undo-btn" data-undo="' + i.hash + '">Undo</button></td></tr>';
        }
        html += '</table></div>';
      }

      if (skipItems.length) {
        html += '<h3><span class="toggle" id="skip-toggle">Skipped / Ignored (' + skipItems.length + ') <span class="arrow" id="skip-arrow">\\u25B6</span></span></h3>';
        html += '<div id="skip-items" class="collapsed"><table><tr><th>Status</th><th>Meeting</th><th>Action Item</th><th></th></tr>';
        for (const i of skipItems) {
          html += '<tr><td><span class="badge skip">' + esc(i.triaged?.status || 'skip') + '</span></td><td>' + esc(i.meeting) + '</td><td>' + esc(i.text) + '</td><td><button class="triage-btn undo-btn" data-undo="' + i.hash + '">Undo</button></td></tr>';
        }
        html += '</table></div>';
      }

      if (!triagedItems.length) html += '<p class="empty">No triaged items yet</p>';
      html += '</div>';

      // Safe DOM update: we control all the data sources (local Jira/Gmail)
      app.innerHTML = html;

      // Attach event listeners via delegation
      app.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));
      document.getElementById('triaged-toggle')?.addEventListener('click', () => toggleCollapse('triaged-section', 'triaged-arrow'));
      document.getElementById('jira-toggle')?.addEventListener('click', () => toggleCollapse('jira-items', 'jira-arrow'));
      document.getElementById('skip-toggle')?.addEventListener('click', () => toggleCollapse('skip-items', 'skip-arrow'));

      app.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', () => {
          triageItem(btn.dataset.hash, btn.dataset.action, btn.dataset.input || '', btn.dataset.text, btn.dataset.meeting);
        });
      });
      app.querySelectorAll('[data-undo]').forEach(btn => {
        btn.addEventListener('click', () => unTriageItem(btn.dataset.undo));
      });

      // Enter key on jira inputs
      app.querySelectorAll('.jira-input').forEach(input => {
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            const btn = input.parentElement.querySelector('.jira-btn');
            if (btn) btn.click();
          }
        });
      });
    }

    // Initial load — use cache for instant render
    fetch('/api/data').then(r => r.json()).then(d => { DATA = d; render(); });
  </script>
</body>
</html>`;
}

server.listen(PORT, () => {
  console.log(`Daily Triage Dashboard: http://localhost:${PORT}`);

  // Auto-refresh every 60 seconds
  setInterval(async () => {
    try {
      const data = await fetchAllData();
      broadcast({ type: "refresh", data });
    } catch (e) {
      console.error("Auto-refresh error:", e.message);
    }
  }, 60000);
});
