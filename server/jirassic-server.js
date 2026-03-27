const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { WebSocketServer } = require("ws");

const PORT = 31337;
const PROJECT_ROOT = process.env.PROJECT_ROOT || path.join(__dirname, "..");
const CLI_DIR = path.join(PROJECT_ROOT, "cli");
const ASSETS_DIR = path.join(PROJECT_ROOT, "assets");
const STATE_DIR = path.join(process.env.HOME, ".config", "daily-triage");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const CACHE_FILE = path.join(STATE_DIR, "cache.json");
const PYTHON = "python3";
const JIRA_SITE = process.env.JIRA_SITE || "redhat.atlassian.net";
const IS_MACOS = process.platform === "darwin";

// Cache the current Jira user's account ID (resolved on first use)
let jiraAccountId = null;
async function getJiraAccountId() {
  if (jiraAccountId) return jiraAccountId;
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  if (!email || !token) return null;
  const auth = Buffer.from(`${email}:${token}`).toString("base64");
  const resp = await fetch(`https://${JIRA_SITE}/rest/api/3/myself`, {
    headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
  });
  if (resp.ok) {
    const data = await resp.json();
    jiraAccountId = data.accountId;
    return jiraAccountId;
  }
  return null;
}

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
      [path.join(CLI_DIR, name), ...args],
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

async function fetchAllData(overrideDays) {
  const project = process.env.TRIAGE_PROJECT || "";
  const days = overrideDays || process.env.TRIAGE_DAYS || "7";

  const [actionItems, tickets] = await Promise.all([
    runScript("my-action-items", ["--json", String(days)]),
    runScript("my-jira-tickets", [
      "--json",
      "--include-closed",
      ...(project ? ["--project", project] : []),
    ]),
  ]);

  const data = buildData(actionItems, tickets);
  data._raw = { actionItems, tickets };
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
  const sprintStart = sprintTickets[0]?.sprint_start || "";
  const sprintEnd = sprintTickets[0]?.sprint_end || "";

  // Find the most recent closed sprint (highest sprint number)
  let lastSprintName = "";
  for (const t of tickets) {
    if (t.last_sprint && (!lastSprintName || t.last_sprint.localeCompare(lastSprintName, undefined, { numeric: true }) > 0)) {
      lastSprintName = t.last_sprint;
    }
  }
  const lastSprintTickets = lastSprintName
    ? tickets.filter((t) => t.last_sprint === lastSprintName && !t.sprint && !t.future_sprint)
    : [];

  // Group future sprint tickets by sprint name
  const futureSprintMap = {};
  for (const t of tickets) {
    if (t.future_sprint) {
      if (!futureSprintMap[t.future_sprint]) futureSprintMap[t.future_sprint] = [];
      futureSprintMap[t.future_sprint].push(t);
    }
  }
  const futureSprints = Object.entries(futureSprintMap).map(([name, tix]) => ({ name, tickets: tix }));

  // Closed tickets only appear if they belong to current, last, or future sprint
  const closedStatuses = new Set(['Closed', 'Done']);
  const relevantSprintNames = new Set([sprintName, lastSprintName, ...Object.keys(futureSprintMap)].filter(Boolean));

  const backlogTickets = tickets.filter(
    (t) => !t.sprint && !t.last_sprint && !t.future_sprint && !closedStatuses.has(t.status)
  );

  // Filter the "all" list: open tickets + closed tickets only from relevant sprints
  const allTickets = tickets.filter((t) => {
    if (!closedStatuses.has(t.status)) return true;
    // Closed ticket: include only if in a relevant sprint
    if (t.sprint) return true; // in current sprint
    if (t.last_sprint === lastSprintName) return true; // in last sprint
    if (t.future_sprint) return true; // in a future sprint
    return false;
  });

  // Find parent epic keys that aren't in the ticket list (closed/other assignee)
  const ticketKeys = new Set(tickets.map(t => t.key));
  const missingParents = new Set();
  for (const t of tickets) {
    if (t.parent && !ticketKeys.has(t.parent)) {
      missingParents.add(t.parent);
    }
  }

  return {
    newItems,
    triagedItems,
    tickets: allTickets,
    missingParents: Array.from(missingParents),
    sprintTickets,
    sprintName,
    sprintStart,
    sprintEnd,
    lastSprintTickets,
    lastSprintName,
    futureSprints,
    backlogTickets,
    sprintsEnabled: process.env.TRIAGE_SPRINTS !== "false",
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

  if (req.method === "POST" && (req.url === "/api/refresh" || req.url.startsWith("/api/refresh?"))) {
    const params = new URL(req.url, "http://localhost").searchParams;
    const overrideDays = params.get("days");
    const data = await fetchAllData(overrideDays);
    notifyNewActionItems(data);
    broadcast({ type: "refresh", data });
    json({ ok: true });
    return;
  }

  if (req.method === "POST" && req.url === "/api/triage") {
    try {
      const { hash, status, ticket, ticketSummary, text, meeting } = JSON.parse(
        await readBody(req)
      );
      const state = loadState();
      state.triaged[hash] = {
        text,
        meeting,
        status,
        ...(ticket ? { ticket } : {}),
        ...(ticketSummary ? { ticketSummary } : {}),
        triaged: new Date().toISOString(),
      };
      saveState(state);
      // Rebuild from last raw data cache without re-fetching
      const cached = loadCache();
      if (cached) {
        // Re-derive state overlay on cached data
        const rebuilt = buildData(cached._raw?.actionItems || [], cached._raw?.tickets || []);
        rebuilt._raw = cached._raw;
        saveCache(rebuilt);
        broadcast({ type: "refresh", data: rebuilt });
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
      // Rebuild from cache without re-fetching
      const cached = loadCache();
      if (cached && cached._raw) {
        const rebuilt = buildData(cached._raw.actionItems || [], cached._raw.tickets || []);
        rebuilt._raw = cached._raw;
        saveCache(rebuilt);
        broadcast({ type: "refresh", data: rebuilt });
      }
      json({ ok: true });
    } catch (e) {
      json({ error: e.message }, 400);
    }
    return;
  }

  // Jira API proxy — look up a single issue
  if (req.method === "GET" && req.url.startsWith("/api/jira/issue/")) {
    try {
      const key = req.url.split("/api/jira/issue/")[1];
      const email = process.env.JIRA_EMAIL;
      const token = process.env.JIRA_API_TOKEN;
      const auth = Buffer.from(`${email}:${token}`).toString("base64");
      const resp = await fetch(`https://${JIRA_SITE}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,status`, {
        headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
      });
      if (resp.ok) {
        const data = await resp.json();
        json({ key: data.key, summary: data.fields.summary, status: data.fields.status.name });
      } else {
        json({ key, summary: "", status: "unknown" });
      }
    } catch (e) {
      json({ error: e.message }, 500);
    }
    return;
  }

  // Jira API proxy — list active + future sprints
  if (req.method === "GET" && req.url === "/api/jira/future-sprints") {
    try {
      const email = process.env.JIRA_EMAIL;
      const token = process.env.JIRA_API_TOKEN;
      const auth = Buffer.from(`${email}:${token}`).toString("base64");
      const boardId = process.env.TRIAGE_BOARD || "1274";
      const headers = { Authorization: `Basic ${auth}`, Accept: "application/json" };

      const [activeResp, futureResp] = await Promise.all([
        fetch(`https://${JIRA_SITE}/rest/agile/1.0/board/${boardId}/sprint?state=active`, { headers }),
        fetch(`https://${JIRA_SITE}/rest/agile/1.0/board/${boardId}/sprint?state=future`, { headers }),
      ]);
      const activeData = await activeResp.json();
      const futureData = await futureResp.json();
      const activeSprints = (activeData.values || []).map(s => ({ id: s.id, name: s.name, state: 'active' }));
      const futureSprints = (futureData.values || []).map(s => ({ id: s.id, name: s.name, state: 'future' }));
      json({ sprints: [...activeSprints, ...futureSprints] });
    } catch (e) {
      json({ error: e.message }, 500);
    }
    return;
  }

  // Jira API proxy — move ticket to a sprint
  if (req.method === "POST" && req.url === "/api/jira/next-sprint") {
    try {
      const { key, sprintId } = JSON.parse(await readBody(req));
      const email = process.env.JIRA_EMAIL;
      const token = process.env.JIRA_API_TOKEN;
      const auth = Buffer.from(`${email}:${token}`).toString("base64");
      const boardId = process.env.TRIAGE_BOARD || "1274";

      let targetSprint;
      if (sprintId) {
        // Use the sprint ID provided by the caller
        targetSprint = { id: sprintId };
      } else {
        // Fall back to next future sprint
        const sprintResp = await fetch(`https://${JIRA_SITE}/rest/agile/1.0/board/${boardId}/sprint?state=future&maxResults=1`, {
          headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
        });
        const sprintData = await sprintResp.json();
        targetSprint = sprintData.values?.[0];
        if (!targetSprint) {
          json({ error: "No future sprint found" }, 400);
          return;
        }
      }

      // Move issue to sprint
      const moveResp = await fetch(`https://${JIRA_SITE}/rest/agile/1.0/sprint/${targetSprint.id}/issue`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ issues: [key] }),
      });
      if (moveResp.status === 204 || moveResp.ok) {
        // If we used a provided sprintId, fetch the sprint name for the toast
        let sprintName = targetSprint.name;
        if (!sprintName && sprintId) {
          try {
            const infoResp = await fetch(`https://${JIRA_SITE}/rest/agile/1.0/sprint/${sprintId}`, {
              headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
            });
            const info = await infoResp.json();
            sprintName = info.name || `Sprint ${sprintId}`;
          } catch { sprintName = `Sprint ${sprintId}`; }
        }
        json({ ok: true, sprint: sprintName });
      } else {
        const data = await moveResp.json();
        json({ error: JSON.stringify(data.errors || data.errorMessages || data) }, 400);
      }
    } catch (e) {
      json({ error: e.message }, 500);
    }
    return;
  }

  // Jira API proxy — create an epic
  if (req.method === "POST" && req.url === "/api/jira/create-epic") {
    try {
      const { summary, assignToMe, priority } = JSON.parse(await readBody(req));
      const project = process.env.TRIAGE_PROJECT || "GPTEINFRA";
      const email = process.env.JIRA_EMAIL;
      const token = process.env.JIRA_API_TOKEN;
      const auth = Buffer.from(`${email}:${token}`).toString("base64");

      const fields = {
        project: { key: project },
        summary,
        issuetype: { name: "Epic" },
      };
      if (assignToMe !== false) {
        const accountId = await getJiraAccountId();
        if (accountId) fields.assignee = { id: accountId };
      }
      if (priority) fields.priority = { name: priority };

      const resp = await fetch(`https://${JIRA_SITE}/rest/api/3/issue`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ fields }),
      });
      const data = await resp.json();
      if (data.key) {
        json({ ok: true, key: data.key });
      } else {
        json({ error: JSON.stringify(data.errors || data.errorMessages || data) }, 400);
      }
    } catch (e) {
      json({ error: e.message }, 500);
    }
    return;
  }

  // Jira API proxy — update a ticket field
  if (req.method === "POST" && req.url === "/api/jira/update") {
    try {
      const { key, fields } = JSON.parse(await readBody(req));
      const email = process.env.JIRA_EMAIL;
      const token = process.env.JIRA_API_TOKEN;
      const auth = Buffer.from(`${email}:${token}`).toString("base64");
      const resp = await fetch(`https://${JIRA_SITE}/rest/api/3/issue/${key}`, {
        method: "PUT",
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ fields }),
      });
      if (resp.status === 204 || resp.ok) {
        json({ ok: true });
      } else {
        const data = await resp.json();
        json({ error: JSON.stringify(data.errors || data.errorMessages || data) }, 400);
      }
    } catch (e) {
      json({ error: e.message }, 500);
    }
    return;
  }

  // Jira API proxy — get transitions for a ticket
  if (req.method === "GET" && req.url.startsWith("/api/jira/transitions/")) {
    try {
      const key = req.url.split("/api/jira/transitions/")[1];
      const email = process.env.JIRA_EMAIL;
      const token = process.env.JIRA_API_TOKEN;
      const auth = Buffer.from(`${email}:${token}`).toString("base64");
      const resp = await fetch(`https://${JIRA_SITE}/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
        headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
      });
      const data = await resp.json();
      json(data.transitions || []);
    } catch (e) {
      json({ error: e.message }, 500);
    }
    return;
  }

  // Jira API proxy — transition a ticket
  if (req.method === "POST" && req.url === "/api/jira/transition") {
    try {
      const { key, transitionId } = JSON.parse(await readBody(req));
      const email = process.env.JIRA_EMAIL;
      const token = process.env.JIRA_API_TOKEN;
      const auth = Buffer.from(`${email}:${token}`).toString("base64");
      const resp = await fetch(`https://${JIRA_SITE}/rest/api/3/issue/${key}/transitions`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ transition: { id: transitionId } }),
      });
      if (resp.status === 204 || resp.ok) {
        json({ ok: true });
      } else {
        const data = await resp.json();
        json({ error: JSON.stringify(data.errors || data.errorMessages || data) }, 400);
      }
    } catch (e) {
      json({ error: e.message }, 500);
    }
    return;
  }

  // Config page
  if (req.method === "GET" && req.url === "/config") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(getConfigHTML());
    return;
  }

  // Config API — read env vars
  if (req.method === "GET" && req.url === "/api/config") {
    const envFile = path.join(process.env.HOME, ".env");
    let envVars = {};
    try {
      const content = fs.readFileSync(envFile, "utf8");
      for (const line of content.split("\n")) {
        const match = line.match(/^export\s+(\w+)="(.*)"/);
        if (match) envVars[match[1]] = match[2];
      }
    } catch {}

    // Mask tokens — show first 8 + last 4 chars
    const mask = (val) => {
      if (!val || val.length < 16) return val ? "***" : "";
      return val.slice(0, 8) + "..." + val.slice(-4);
    };

    json({
      JIRA_EMAIL: envVars.JIRA_EMAIL || "",
      JIRA_API_TOKEN: mask(envVars.JIRA_API_TOKEN),
      JIRA_API_TOKEN_SET: !!envVars.JIRA_API_TOKEN,
      JIRA_SITE: envVars.JIRA_SITE || process.env.JIRA_SITE || "redhat.atlassian.net",
      GWS_NAME: envVars.GWS_NAME || process.env.GWS_NAME || "",
      TRIAGE_SPRINTS: envVars.TRIAGE_SPRINTS || process.env.TRIAGE_SPRINTS || "true",
      TRIAGE_NOTIFICATIONS: envVars.TRIAGE_NOTIFICATIONS || process.env.TRIAGE_NOTIFICATIONS || "true",
      TRIAGE_PROJECT: envVars.TRIAGE_PROJECT || process.env.TRIAGE_PROJECT || "",
      TRIAGE_DAYS: envVars.TRIAGE_DAYS || process.env.TRIAGE_DAYS || "7",
    });
    return;
  }

  // Config API — save env vars to ~/.env
  if (req.method === "POST" && req.url === "/api/config") {
    try {
      const updates = JSON.parse(await readBody(req));
      const envFile = path.join(process.env.HOME, ".env");

      let lines = [];
      try { lines = fs.readFileSync(envFile, "utf8").split("\n"); } catch {}

      for (const [key, value] of Object.entries(updates)) {
        if (!value && value !== "") continue; // skip undefined
        const pattern = new RegExp("^export\\s+" + key + "=");
        const idx = lines.findIndex((l) => pattern.test(l));
        const newLine = 'export ' + key + '="' + value + '"';
        if (idx >= 0) {
          lines[idx] = newLine;
        } else {
          lines.push(newLine);
        }
        // Also update process.env so changes take effect immediately
        process.env[key] = value;
      }

      fs.writeFileSync(envFile, lines.filter((l) => l !== "").join("\n") + "\n");
      json({ ok: true });
    } catch (e) {
      json({ error: e.message }, 500);
    }
    return;
  }

  // Health check — verify Jira and GWS connectivity
  if (req.method === "GET" && req.url === "/api/health") {
    const results = {};

    // Check Jira
    try {
      const email = process.env.JIRA_EMAIL;
      const token = process.env.JIRA_API_TOKEN;
      const auth = Buffer.from(`${email}:${token}`).toString("base64");
      const resp = await fetch(`https://${JIRA_SITE}/rest/api/3/myself`, {
        headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
      });
      if (resp.ok) {
        const data = await resp.json();
        results.jira = { ok: true, user: data.displayName };
      } else {
        results.jira = { ok: false, error: `HTTP ${resp.status}` };
      }
    } catch (e) {
      results.jira = { ok: false, error: e.message };
    }

    // Check GWS
    try {
      const { execFileSync } = require("child_process");
      const out = execFileSync("gws", ["auth", "status"], { timeout: 10000, encoding: "utf8" });
      const data = JSON.parse(out);
      results.gws = { ok: data.token_valid === true, user: data.user || "" };
    } catch (e) {
      results.gws = { ok: false, error: e.message };
    }

    json(results);
    return;
  }

  // Jira API proxy — get epics and tickets for linking
  if (req.method === "GET" && req.url === "/api/jira/epics") {
    try {
      const project = process.env.TRIAGE_PROJECT || "GPTEINFRA";
      const email = process.env.JIRA_EMAIL;
      const token = process.env.JIRA_API_TOKEN;
      const auth = Buffer.from(`${email}:${token}`).toString("base64");
      const jql = encodeURIComponent(
        `project = ${project} AND assignee = currentUser() AND issuetype = Epic AND status NOT IN (Done, Closed) ORDER BY updated DESC`
      );
      const url = `https://${JIRA_SITE}/rest/api/3/search/jql?jql=${jql}&fields=summary,status&maxResults=50`;
      const resp = await fetch(url, {
        headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
      });
      const data = await resp.json();
      const epics = (data.issues || []).map((i) => ({
        key: i.key,
        summary: i.fields.summary,
        status: i.fields.status.name,
      }));
      json(epics);
    } catch (e) {
      json({ error: e.message }, 500);
    }
    return;
  }

  // Jira API proxy — create a ticket
  if (req.method === "POST" && req.url === "/api/jira/create") {
    try {
      const { summary, epicKey, description, assignToMe, storyPoints, priority } = JSON.parse(await readBody(req));
      const project = process.env.TRIAGE_PROJECT || "GPTEINFRA";
      const email = process.env.JIRA_EMAIL;
      const token = process.env.JIRA_API_TOKEN;
      const auth = Buffer.from(`${email}:${token}`).toString("base64");

      const fields = {
        project: { key: project },
        summary,
        issuetype: { name: "Task" },
      };
      if (assignToMe !== false) {
        const accountId = await getJiraAccountId();
        if (accountId) fields.assignee = { id: accountId };
      }
      if (epicKey) fields.parent = { key: epicKey };
      if (storyPoints) fields.customfield_10028 = parseFloat(storyPoints);
      if (priority) fields.priority = { name: priority };
      if (description) {
        fields.description = {
          type: "doc",
          version: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text: description }] }],
        };
      }

      const resp = await fetch(`https://${JIRA_SITE}/rest/api/3/issue`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ fields }),
      });
      const data = await resp.json();
      if (data.key) {
        json({ ok: true, key: data.key, url: `https://${JIRA_SITE}/browse/${data.key}` });
      } else {
        json({ error: JSON.stringify(data.errors || data.errorMessages || data) }, 400);
      }
    } catch (e) {
      json({ error: e.message }, 500);
    }
    return;
  }

  if (req.method === "GET" && req.url === "/logo.png") {
    const logoPath = path.join(ASSETS_DIR, "logo.png");
    try {
      const data = fs.readFileSync(logoPath);
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end();
    }
    return;
  }

  if (req.method === "GET" && req.url === "/favicon.ico") {
    const faviconPath = path.join(ASSETS_DIR, "favicon.ico");
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

function getConfigHTML() {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Jirassic — Configuration</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    :root {
      --bg: #0d1117; --bg2: #161b22; --bg3: #21262d; --border: #30363d;
      --text: #c9d1d9; --text-muted: #8b949e; --text-bright: #f0f6fc;
      --link: #58a6ff; --hover-bg: #161b22;
    }
    [data-theme="light"] {
      --bg: #ffffff; --bg2: #f6f8fa; --bg3: #e1e4e8; --border: #d0d7de;
      --text: #24292f; --text-muted: #57606a; --text-bright: #24292f;
      --link: #0969da; --hover-bg: #f6f8fa;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); padding: 2rem; max-width: 700px; margin: 0 auto; }
    h1 { color: var(--text-bright); margin-bottom: 0.5rem; }
    .back { color: var(--link); text-decoration: none; font-size: 0.9rem; }
    .back:hover { text-decoration: underline; }
    h2 { color: var(--text-bright); margin: 2rem 0 1rem; border-bottom: 1px solid var(--border); padding-bottom: 0.5rem; }
    .field { margin-bottom: 1.5rem; }
    .field label { display: block; color: var(--text-bright); font-weight: 600; margin-bottom: 0.3rem; font-size: 0.9rem; }
    .field .desc { color: var(--text-muted); font-size: 0.8rem; margin-bottom: 0.5rem; }
    .field .desc a { color: var(--text-bright); font-weight: 600; }
    .field .desc a:hover { color: var(--link); }
    .field input { width: 100%; background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 8px; border-radius: 6px; font-size: 0.9rem; }
    .field input:focus { border-color: var(--link); outline: none; }
    .field input::placeholder { color: var(--text-muted); }
    .status-row { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.5rem; font-size: 0.85rem; }
    .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
    .status-dot.ok { background: #238636; }
    .status-dot.warn { background: #e3b341; }
    .status-dot.err { background: #da3633; }
    .btn { padding: 6px 16px; border-radius: 6px; border: 1px solid var(--border); cursor: pointer; font-size: 0.85rem; }
    .btn-primary { background: #238636; color: #fff; border-color: #238636; }
    .btn-primary:hover { background: #2ea043; }
    .btn-secondary { background: var(--bg3); color: var(--text); }
    .btn-secondary:hover { opacity: 0.8; }
    .actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
    .warning { background: #e3b34122; border: 1px solid #e3b341; color: #e3b341; padding: 0.7rem 1rem; border-radius: 6px; margin-bottom: 1rem; font-size: 0.85rem; }
    .warning a { color: #e3b341; }
    .success { background: #23863622; border: 1px solid #238636; color: #238636; padding: 0.7rem 1rem; border-radius: 6px; margin-bottom: 1rem; font-size: 0.85rem; }
    .toast { position: fixed; bottom: 2rem; right: 2rem; background: #238636; color: #fff; padding: 0.5rem 1rem; border-radius: 6px; font-size: 0.9rem; opacity: 0; transition: opacity 0.3s; pointer-events: none; z-index: 100; }
    .toast.show { opacity: 1; }
    .readonly { opacity: 0.7; }
    .name-tag { display: inline-flex; align-items: center; gap: 0.3rem; background: var(--bg3); border: 1px solid var(--border); padding: 3px 8px; border-radius: 12px; font-size: 0.85rem; margin: 0.2rem; }
    .name-tag .remove { cursor: pointer; color: var(--text-muted); font-size: 0.75rem; }
    .name-tag .remove:hover { color: #da3633; }
  </style>
</head>
<body>
  <a href="/" class="back">&larr; Back to Dashboard</a>
  <h1>Configuration</h1>

  <div id="alerts"></div>

  <h2>Jira</h2>
  <div class="field">
    <label>JIRA_EMAIL</label>
    <div class="desc">Your Atlassian account email address</div>
    <input type="text" id="jira-em" placeholder="you@example.com" autocomplete="off" data-lpignore="true" data-1p-ignore="true">
  </div>
  <div class="field">
    <label>JIRA_API_TOKEN</label>
    <div class="desc" id="token-expiry-note">Create at <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank">id.atlassian.com</a>. Tokens do not expire by default — check your org's policy.</div>
    <input type="text" id="jira-token" placeholder="Paste your API token" autocomplete="off" data-lpignore="true" data-1p-ignore="true">
    <div class="status-row">
      <span class="status-dot" id="jira-dot"></span>
      <span id="jira-status">Checking...</span>
    </div>
  </div>
  <div class="field">
    <label>JIRA_SITE</label>
    <div class="desc">Jira Cloud site hostname</div>
    <input type="text" id="jira-site" placeholder="your-org.atlassian.net">
  </div>
  <div class="actions">
    <button class="btn btn-primary" id="save-jira">Save Jira Settings</button>
    <button class="btn btn-secondary" id="verify-jira">Verify Connection</button>
  </div>

  <h2>Google Workspace (GWS)</h2>
  <div class="field">
    <label>GWS_NAME</label>
    <div class="desc">Names Gemini might use when referring to you in meeting notes. Add leading or trailing spaces to short names to avoid false matches (e.g. "Pat " won't match "Pattern").</div>
    <div id="gws-name-list" style="margin-bottom:0.5rem"></div>
    <div style="display:flex;gap:0.5rem">
      <input type="text" id="gws-name-input" placeholder="Add a name variant (use leading/trailing space to avoid false matches)" autocomplete="off" data-lpignore="true" data-1p-ignore="true" style="flex:1">
      <button class="btn btn-secondary" id="gws-name-add">Add</button>
    </div>
    <div class="status-row">
      <span class="status-dot" id="gws-dot"></span>
      <span id="gws-status">Checking...</span>
    </div>
  </div>
  <div class="field">
    <label>GWS Authentication</label>
    <div class="desc">GWS uses OAuth via the <code>gws</code> CLI. Run <code>gws auth login</code> in your terminal to authenticate.</div>
    <div class="desc" id="gws-docs-link" style="display:none"><a href="https://redhat.atlassian.net/wiki/spaces/RHPDS/pages/380283680/Google+Workspace+CLI+gws+Setup+Guide" target="_blank">GWS Setup Guide (RHDP Confluence)</a></div>
    <div class="status-row">
      <span class="status-dot" id="gws-auth-dot"></span>
      <span id="gws-auth-status">Checking...</span>
    </div>
  </div>

  <h2>Dashboard Settings</h2>
  <div class="field">
    <label>Sprint Tabs</label>
    <div class="desc">Show sprint tabs (Current, Next, Last) on the dashboard. Disable if your project doesn't use sprints.</div>
    <select id="cfg-sprints" style="background:var(--bg);border:1px solid var(--border);color:var(--text);padding:6px 8px;border-radius:6px;font-size:0.9rem;">
      <option value="true">Enabled</option>
      <option value="false">Disabled</option>
    </select>
  </div>
  <div class="field">
    <label>Desktop Notifications</label>
    <div class="desc">Show macOS notifications when new action items are detected. Only works on macOS.</div>
    <select id="cfg-notifications" style="background:var(--bg);border:1px solid var(--border);color:var(--text);padding:6px 8px;border-radius:6px;font-size:0.9rem;">
      <option value="true">Enabled</option>
      <option value="false">Disabled</option>
    </select>
  </div>
  <div class="field">
    <label>TRIAGE_PROJECT</label>
    <div class="desc">Default Jira project filter (leave empty for all projects)</div>
    <input type="text" id="cfg-project" placeholder="e.g. GPTEINFRA" autocomplete="off">
  </div>
  <div class="field">
    <label>TRIAGE_DAYS</label>
    <div class="desc">How many days of meeting notes to search</div>
    <input type="text" id="cfg-days" placeholder="7" autocomplete="off" style="max-width:80px;">
  </div>
  <div class="actions">
    <button class="btn btn-primary" id="save-dashboard">Save Dashboard Settings</button>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    const savedTheme = localStorage.getItem('jirassic-theme') || 'dark';
    if (savedTheme === 'light') document.documentElement.setAttribute('data-theme', 'light');

    function showToast(msg) {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.classList.add('show');
      setTimeout(() => el.classList.remove('show'), 2000);
    }

    let gwsNames = [];

    function renderNameList(nameStr) {
      gwsNames = nameStr ? nameStr.split(':').filter(n => n) : [];
      const container = document.getElementById('gws-name-list');
      container.textContent = '';
      gwsNames.forEach((name, i) => {
        const tag = document.createElement('span');
        tag.className = 'name-tag';
        const text = document.createElement('span');
        const hasLeading = name.startsWith(' ');
        const hasTrailing = name.endsWith(' ');
        const display = (hasLeading ? '·' : '') + name.trim() + (hasTrailing ? '·' : '');
        text.textContent = display;
        if (hasLeading || hasTrailing) text.title = 'Includes ' + (hasLeading && hasTrailing ? 'leading and trailing' : hasLeading ? 'leading' : 'trailing') + ' space';
        tag.appendChild(text);
        const remove = document.createElement('span');
        remove.className = 'remove';
        remove.textContent = '✕';
        remove.addEventListener('click', () => {
          gwsNames.splice(i, 1);
          saveGwsNames();
        });
        tag.appendChild(remove);
        container.appendChild(tag);
      });
      if (!gwsNames.length) {
        container.innerHTML = '<span style="color:var(--text-muted);font-size:0.85rem">No names configured</span>';
      }
    }

    async function saveGwsNames() {
      const val = gwsNames.join(':');
      renderNameList(val);
      const resp = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ GWS_NAME: val }),
      });
      const result = await resp.json();
      if (result.ok) {
        showToast('GWS names saved');
      } else {
        showToast('Error: ' + (result.error || 'unknown'));
      }
    }

    document.getElementById('gws-name-add').addEventListener('click', () => {
      const input = document.getElementById('gws-name-input');
      const val = input.value;
      if (!val) return;
      gwsNames.push(val);
      input.value = '';
      saveGwsNames();
    });

    document.getElementById('gws-name-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('gws-name-add').click();
    });

    async function loadConfig() {
      const [configResp, healthResp] = await Promise.all([
        fetch('/api/config'),
        fetch('/api/health'),
      ]);
      const config = await configResp.json();
      const health = await healthResp.json();

      document.getElementById('jira-em').value = config.JIRA_EMAIL || '';
      document.getElementById('jira-site').value = config.JIRA_SITE || '';
      renderNameList(config.GWS_NAME || '');

      // Dashboard settings
      document.getElementById('cfg-sprints').value = config.TRIAGE_SPRINTS === 'false' ? 'false' : 'true';
      document.getElementById('cfg-notifications').value = config.TRIAGE_NOTIFICATIONS === 'false' ? 'false' : 'true';
      document.getElementById('cfg-project').value = config.TRIAGE_PROJECT || '';
      document.getElementById('cfg-days').value = config.TRIAGE_DAYS || '7';

      if (config.JIRA_API_TOKEN_SET) {
        document.getElementById('jira-token').placeholder = 'Token set (' + config.JIRA_API_TOKEN + ')';
      }

      // Red Hat org-specific token warning
      if (config.JIRA_EMAIL && config.JIRA_EMAIL.endsWith('@redhat.com')) {
        document.getElementById('token-expiry-note').innerHTML = 'Create at <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank">id.atlassian.com</a>. ⚠️ <strong>Red Hat org tokens expire periodically.</strong> Check your tokens page regularly and update here if expired.';
      }

      const alerts = document.getElementById('alerts');
      alerts.textContent = '';

      // Jira status
      if (health.jira?.ok) {
        document.getElementById('jira-dot').className = 'status-dot ok';
        document.getElementById('jira-status').textContent = 'Connected as ' + health.jira.user;
      } else if (!config.JIRA_API_TOKEN_SET) {
        document.getElementById('jira-dot').className = 'status-dot err';
        document.getElementById('jira-status').textContent = 'Not configured';
        const warn = document.createElement('div');
        warn.className = 'warning';
        warn.innerHTML = 'Jira is not configured. Enter your email and <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank">create an API token</a> to get started.';
        alerts.appendChild(warn);
      } else {
        document.getElementById('jira-dot').className = 'status-dot err';
        document.getElementById('jira-status').textContent = 'Connection failed: ' + (health.jira?.error || 'unknown');
      }

      // GWS status
      if (config.GWS_NAME) {
        document.getElementById('gws-dot').className = 'status-dot ok';
        document.getElementById('gws-status').textContent = 'Set to: "' + config.GWS_NAME + '"';
      } else {
        document.getElementById('gws-dot').className = 'status-dot warn';
        document.getElementById('gws-status').textContent = 'Not set — add export GWS_NAME="Your Name" to ~/.zshrc';
      }

      if (health.gws?.ok) {
        document.getElementById('gws-auth-dot').className = 'status-dot ok';
        document.getElementById('gws-auth-status').textContent = 'Authenticated as ' + health.gws.user;
        if (health.gws.user && health.gws.user.endsWith('@redhat.com')) {
          document.getElementById('gws-docs-link').style.display = '';
        }
      } else {
        document.getElementById('gws-auth-dot').className = 'status-dot err';
        document.getElementById('gws-auth-status').textContent = 'Not authenticated — run gws auth login in terminal';
      }
      // Also show docs link based on Jira email
      if (config.JIRA_EMAIL && config.JIRA_EMAIL.endsWith('@redhat.com')) {
        document.getElementById('gws-docs-link').style.display = '';
      }
    }

    document.getElementById('save-jira').addEventListener('click', async () => {
      const updates = {};
      const email = document.getElementById('jira-em').value.trim();
      const token = document.getElementById('jira-token').value.trim();
      const site = document.getElementById('jira-site').value.trim();

      if (email) updates.JIRA_EMAIL = email;
      if (token) updates.JIRA_API_TOKEN = token;
      if (site) updates.JIRA_SITE = site;

      if (!Object.keys(updates).length) { showToast('Nothing to save'); return; }

      const resp = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      const result = await resp.json();
      if (result.ok) {
        showToast('Saved! Verifying...');
        document.getElementById('jira-token').value = '';
        await loadConfig();
      } else {
        showToast('Error: ' + (result.error || 'unknown'));
      }
    });

    document.getElementById('verify-jira').addEventListener('click', async () => {
      document.getElementById('jira-dot').className = 'status-dot warn';
      document.getElementById('jira-status').textContent = 'Verifying...';
      const resp = await fetch('/api/health');
      const health = await resp.json();
      if (health.jira?.ok) {
        document.getElementById('jira-dot').className = 'status-dot ok';
        document.getElementById('jira-status').textContent = 'Connected as ' + health.jira.user;
        showToast('Jira connection verified');
      } else {
        document.getElementById('jira-dot').className = 'status-dot err';
        document.getElementById('jira-status').textContent = 'Failed: ' + (health.jira?.error || 'unknown');
        showToast('Connection failed');
      }
    });

    document.getElementById('save-dashboard').addEventListener('click', async () => {
      const updates = {
        TRIAGE_SPRINTS: document.getElementById('cfg-sprints').value,
        TRIAGE_NOTIFICATIONS: document.getElementById('cfg-notifications').value,
        TRIAGE_PROJECT: document.getElementById('cfg-project').value.trim(),
        TRIAGE_DAYS: document.getElementById('cfg-days').value.trim() || '7',
      };
      const resp = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      const result = await resp.json();
      if (result.ok) {
        showToast('Dashboard settings saved');
        fetch('/api/refresh', { method: 'POST' });
      } else {
        showToast('Error: ' + (result.error || 'unknown'));
      }
    });

    loadConfig();
  </script>
</body>
</html>`;
}

function getDashboardHTML() {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Jirassic — the Daily Triage Dashboard</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --bg: #0d1117; --bg2: #161b22; --bg3: #21262d; --border: #30363d;
      --text: #c9d1d9; --text-muted: #8b949e; --text-bright: #f0f6fc;
      --link: #58a6ff; --hover-bg: #161b22;
    }
    [data-theme="light"] {
      --bg: #ffffff; --bg2: #f6f8fa; --bg3: #e1e4e8; --border: #d0d7de;
      --text: #24292f; --text-muted: #57606a; --text-bright: #24292f;
      --link: #0969da; --hover-bg: #f6f8fa;
    }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); padding: 2rem; transition: background 0.2s, color 0.2s; }
    h1 { color: var(--text-bright); margin-bottom: 0.5rem; }
    .header { display: flex; align-items: center; gap: 1rem; margin-bottom: 0.5rem; flex-wrap: wrap; }
    .updated { color: var(--text-muted); font-size: 0.9rem; margin-bottom: 2rem; }
    .refresh-btn, .theme-btn { background: var(--bg3); color: var(--text); border: 1px solid var(--border); padding: 4px 12px; border-radius: 6px; cursor: pointer; font-size: 0.85rem; }
    .refresh-btn:hover, .theme-btn:hover { opacity: 0.8; }
    .refresh-btn.loading { opacity: 0.5; cursor: wait; }
    .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
    .status-dot.connected { background: #238636; }
    .status-dot.disconnected { background: #da3633; }
    h2 { color: var(--text-bright); margin: 2rem 0 1rem; border-bottom: 1px solid var(--border); padding-bottom: 0.5rem; }
    h3 { color: var(--text); margin: 1.5rem 0 0.5rem; font-size: 0.95rem; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 1rem; }
    th { text-align: left; padding: 0.5rem; color: var(--text-muted); border-bottom: 1px solid var(--border); font-size: 0.85rem; }
    td { padding: 0.5rem; border-bottom: 1px solid var(--border); font-size: 0.9rem; }
    tr:hover { background: var(--hover-bg); }
    .epic-row { background: var(--bg2); }
    .epic-row td { font-weight: 600; padding-top: 0.7rem; padding-bottom: 0.7rem; border-left: 3px solid #1f6feb; }
    .epic-row:hover td { border-left-color: var(--link); }
    .epic-arrow { cursor: pointer; }
    .epic-child td { border-left: 3px solid var(--border); padding-left: 2rem; }
    .epic-child td:first-child { padding-left: 2.5rem; }
    .epic-children.collapsed { display: none; }
    .epic-arrow { font-size: 0.7rem; margin-right: 0.3rem; display: inline-block; }
    a { color: var(--link); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .sp-cell { color: var(--text-bright); font-weight: 600; }
    .sp-warn { font-size: 0.9rem; }
    .sprint-bar { background: var(--bg3); border-radius: 6px; height: 8px; margin-top: 0.3rem; overflow: hidden; }
    .sprint-bar-fill { height: 100%; border-radius: 6px; transition: width 0.3s; }
    .sprint-info { display: flex; justify-content: space-between; align-items: center; font-size: 0.85rem; color: var(--text-muted); margin-top: 0.5rem; }
    .sp-total { font-weight: 700; padding: 2px 10px; border-radius: 12px; font-size: 0.85rem; }
    .sp-green { background: #23863633; color: #238636; }
    .sp-yellow { background: #e3b34133; color: #e3b341; }
    .sp-red { background: #da363333; color: #da3633; }
    .sp-none { background: #6e768133; color: #6e7681; }
    .add-btn { background: none; border: 1px dashed var(--border); color: var(--text-muted); padding: 0.3rem 0.8rem; border-radius: 4px; cursor: pointer; font-size: 0.8rem; margin-top: 0.3rem; display: inline-block; }
    .add-btn:hover { border-color: var(--link); color: var(--link); }
    .move-btn { background: none; border: 1px solid var(--border); color: var(--text-muted); padding: 1px 6px; border-radius: 4px; cursor: pointer; font-size: 0.7rem; margin-left: 0.5rem; }
    .move-btn:hover { border-color: var(--link); color: var(--link); }
    .sp-warn-epic { font-size: 0.75rem; background: #e3b341; color: #000; padding: 1px 6px; border-radius: 10px; margin-left: 0.3rem; font-weight: 700; }
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
    .badge.status-closed { background: #30363d; color: #8b949e; }
    .badge.status-done { background: #238636; color: #fff; }
    tr.ticket-closed td { opacity: 0.5; }
    tr.ticket-closed:hover td { opacity: 0.8; }
    .multi-select { position: relative; display: inline-block; }
    .multi-select-btn { padding: 0.4rem 0.5rem; background: var(--bg1); color: var(--text); border: 1px solid var(--border); border-radius: 4px; font-size: 0.85rem; cursor: pointer; min-width: 120px; text-align: left; display: flex; align-items: center; gap: 0.3rem; }
    .multi-select-btn .count { background: #238636; color: #fff; border-radius: 8px; padding: 0 0.4rem; font-size: 0.75rem; }
    .multi-select-btn::after { content: '\\25BC'; font-size: 0.6rem; margin-left: auto; opacity: 0.5; }
    .multi-select-menu { display: none; position: absolute; top: 100%; left: 0; z-index: 300; background: var(--bg2); border: 1px solid var(--border); border-radius: 4px; min-width: 160px; max-height: 250px; overflow-y: auto; box-shadow: 0 4px 12px rgba(0,0,0,0.3); margin-top: 2px; }
    .multi-select-menu.open { display: block; }
    .multi-select-menu label { display: flex; align-items: center; gap: 0.5rem; padding: 0.35rem 0.6rem; cursor: pointer; font-size: 0.85rem; white-space: nowrap; }
    .multi-select-menu label:hover { background: var(--bg1); }
    .multi-select-menu input[type="checkbox"] { accent-color: #238636; }
    .badge.epic { background: #7c3aed; color: #fff; margin-left: 0.4rem; font-size: 0.7rem; }
    .empty { color: var(--text-muted); padding: 1rem; text-align: center; }
    .tabs { display: flex; gap: 0; }
    .tab { padding: 0.6rem 1.2rem; cursor: pointer; border: 1px solid var(--border); border-bottom: none; border-radius: 6px 6px 0 0; background: var(--bg2); color: var(--text-muted); font-size: 0.9rem; }
    .tab.active { background: var(--bg); color: var(--text-bright); border-bottom: 1px solid var(--bg); }
    .tab-content { display: none; border: 1px solid var(--border); border-radius: 0 6px 6px 6px; padding: 1rem; }
    .tab-content.active { display: block; }
    .toggle { cursor: pointer; user-select: none; }
    .toggle:hover { color: var(--link); }
    .arrow { font-size: 0.7rem; margin-left: 0.3rem; }
    .collapsed { display: none; }
    .triage-actions { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
    .triage-btn { padding: 2px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg3); color: var(--text); cursor: pointer; font-size: 0.8rem; }
    .triage-btn:hover { opacity: 0.8; }
    .triage-btn.done-btn:hover { background: #238636; color: #fff; }
    .triage-btn.jira-btn:hover { background: #1f6feb; color: #fff; }
    .triage-btn.undo-btn { border-color: #484f58; }
    .triage-btn.undo-btn:hover { background: #da3633; color: #fff; }
    .jira-input { background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 2px 6px; border-radius: 4px; font-size: 0.8rem; width: 140px; }
    .jira-input::placeholder { color: var(--text-muted); }
    .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); z-index: 200; display: flex; align-items: center; justify-content: center; }
    .modal { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 1.5rem; width: 500px; max-height: 80vh; overflow-y: auto; }
    .modal h3 { color: var(--text-bright); margin-bottom: 1rem; }
    .modal-context { color: var(--text-muted); font-size: 0.85rem; margin-bottom: 1rem; padding: 0.5rem; background: var(--bg); border-radius: 4px; }
    .modal-section { margin-bottom: 1.5rem; }
    .modal-section h4 { color: #c9d1d9; margin-bottom: 0.5rem; font-size: 0.9rem; }
    .epic-list { list-style: none; max-height: 200px; overflow-y: auto; }
    .epic-item { padding: 0.5rem; border: 1px solid var(--border); border-radius: 4px; margin-bottom: 0.3rem; cursor: pointer; display: flex; gap: 0.5rem; align-items: center; }
    .epic-item:hover { background: var(--bg3); border-color: var(--link); }
    .epic-item .epic-key { color: var(--link); font-size: 0.85rem; }
    .epic-item .epic-summary { color: var(--text); font-size: 0.85rem; }
    .modal-input { width: 100%; background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 6px 8px; border-radius: 4px; font-size: 0.9rem; margin-bottom: 0.5rem; }
    .modal-input:focus { border-color: var(--link); outline: none; }
    .modal-input::placeholder { color: var(--text-muted); }
    .modal-actions { display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 1rem; }
    .modal-btn { padding: 6px 16px; border-radius: 6px; border: 1px solid var(--border); cursor: pointer; font-size: 0.85rem; }
    .modal-btn.cancel { background: var(--bg3); color: var(--text); }
    .modal-btn.cancel:hover { opacity: 0.8; }
    .modal-btn.create { background: #238636; color: #fff; border-color: #238636; }
    .modal-btn.create:hover { background: #2ea043; }
    .or-divider { text-align: center; color: var(--text-muted); margin: 0.5rem 0; font-size: 0.85rem; }
    .toast { position: fixed; bottom: 2rem; right: 2rem; background: #238636; color: #fff; padding: 0.5rem 1rem; border-radius: 6px; font-size: 0.9rem; opacity: 0; transition: opacity 0.3s; pointer-events: none; z-index: 100; }
    .toast.show { opacity: 1; }
  </style>
</head>
<body>
  <div class="header">
    <img src="/logo.png" alt="Jirassic" style="height:120px;vertical-align:middle">
    <span style="font-size:1.2em;color:#8b949e;vertical-align:middle">Daily Triage Dashboard</span>
    <span style="display:inline-flex;align-items:center;gap:0.3rem;">
      <input type="number" id="days-input" min="1" max="90" placeholder="${process.env.TRIAGE_DAYS || '7'}" title="Days to search" style="width:45px;padding:4px 6px;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:0.85rem;text-align:center;">
      <span style="color:var(--text-muted);font-size:0.8rem;">days</span>
      <button class="refresh-btn" id="refresh-btn">Refresh</button>
    </span>
    <span><span class="status-dot" id="ws-status"></span><span id="ws-label">connecting</span></span>
    <span style="margin-left:0.5rem"><span class="status-dot" id="jira-status"></span><span id="jira-label">Confirming Jira connectivity...</span></span>
    <span style="margin-left:0.5rem"><span class="status-dot" id="gws-status"></span><span id="gws-label">Confirming GWS connectivity...</span></span>
    <span style="margin-left:auto;display:flex;gap:0.5rem;align-items:center">
      <a href="/config" style="color:var(--text-muted);font-size:0.85rem;text-decoration:none">⚙️ Config</a>
      <button class="theme-btn" id="theme-toggle">☀️ Light</button>
    </span>
  </div>
  <p class="updated" id="updated"></p>
  <div id="app"><p class="empty">Loading...</p></div>
  <div class="toast" id="toast"></div>

  <script>
    const JIRA_SITE = ${JSON.stringify(JIRA_SITE)};
    let DATA = null;
    let activeTab = 'sprint';
    let ticketSearchTerm = '';
    let ticketStatusFilters = new Set();
    let ticketPriorityFilters = new Set();
    const expandedState = {}; // track which collapsibles are expanded

    // Check if a ticket row matches the current filters
    function rowMatchesFilters(row) {
      const term = ticketSearchTerm;
      if (term && !row.textContent.toLowerCase().includes(term)) return false;
      if (ticketStatusFilters.size) {
        const badge = row.querySelector('.editable-status .badge, .badge[class*="status-"]');
        if (badge && !ticketStatusFilters.has(badge.textContent.trim())) return false;
        if (!badge) return false;
      }
      if (ticketPriorityFilters.size) {
        const priCell = row.querySelector('.editable-priority');
        if (priCell && !ticketPriorityFilters.has(priCell.textContent.trim())) return false;
        if (!priCell) return false;
      }
      return true;
    }

    // Filter ticket table rows by search term, status, and priority
    function filterTicketRows() {
      const hasFilters = ticketSearchTerm || ticketStatusFilters.size || ticketPriorityFilters.size;
      document.querySelectorAll('.tab-content').forEach(tab => {
        tab.querySelectorAll('table tr').forEach(row => {
          if (row.querySelector('th')) return; // skip header
          if (row.classList.contains('epic-row')) {
            const eid = row.dataset.toggleEpic;
            const children = eid ? tab.querySelectorAll('.' + eid) : [];
            if (!hasFilters) { row.style.display = ''; children.forEach(c => { if (c.style.display === 'none' && !expandedState['epic-' + eid]) return; }); return; }
            const epicMatches = rowMatchesFilters(row);
            let anyChildMatch = false;
            children.forEach(c => {
              if (c.querySelector('.add-btn')) return;
              if (rowMatchesFilters(c)) anyChildMatch = true;
            });
            row.style.display = (epicMatches || anyChildMatch) ? '' : 'none';
            children.forEach(c => {
              if (c.querySelector('.add-btn')) { c.style.display = (epicMatches || anyChildMatch) ? '' : 'none'; return; }
              c.style.display = (rowMatchesFilters(c) || epicMatches) ? '' : 'none';
            });
          } else if (!row.classList.contains('epic-child')) {
            if (!hasFilters) { row.style.display = ''; return; }
            row.style.display = rowMatchesFilters(row) ? '' : 'none';
          }
        });
      });
    }

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
        if (msg.type === 'refresh') {
          DATA = msg.data;
          render();
        }
      };
    }
    connectWS();

    // --- API ---
    document.getElementById('refresh-btn').onclick = async () => {
      const btn = document.getElementById('refresh-btn');
      const daysInput = document.getElementById('days-input');
      const days = daysInput.value.trim();
      const url = days ? '/api/refresh?days=' + encodeURIComponent(days) : '/api/refresh';
      btn.classList.add('loading');
      btn.textContent = 'Refreshing...';
      await fetch(url, { method: 'POST' });
      btn.classList.remove('loading');
      btn.textContent = 'Refresh';
      if (days) daysInput.value = ''; // Clear override after use
    };

    async function triageItem(hash, status, ticket, text, meeting) {
      await fetch('/api/triage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash, status, ticket, text, meeting }),
      });
      showToast(status === 'skip' ? 'Skipped' : status === 'done' ? 'Marked done' : 'Linked to ' + ticket);
    }

    // Confirm modal
    function confirmCreate(title, summary, parent, options) {
      return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.style.zIndex = '400';
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.style.width = '400px'; modal.style.background = 'var(--bg2)';

        const h = document.createElement('h3');
        h.textContent = title;
        modal.appendChild(h);

        const details = document.createElement('div');
        details.style.cssText = 'margin:1rem 0;font-size:0.9rem;';
        const summaryP = document.createElement('p');
        summaryP.style.cssText = 'margin-bottom:0.5rem;';
        const summaryLabel = document.createElement('span');
        summaryLabel.style.color = 'var(--text-muted)';
        summaryLabel.textContent = 'Summary: ';
        const summaryVal = document.createElement('span');
        summaryVal.style.color = 'var(--text-bright)';
        summaryVal.textContent = summary;
        summaryP.appendChild(summaryLabel);
        summaryP.appendChild(summaryVal);
        details.appendChild(summaryP);
        if (parent) {
          const parentP = document.createElement('p');
          parentP.style.cssText = 'font-size:0.85rem;margin-top:0.2rem;';
          const parentLabel = document.createElement('span');
          parentLabel.style.color = 'var(--text-muted)';
          parentLabel.textContent = 'Parent: ';
          const parentVal = document.createElement('span');
          parentVal.style.color = 'var(--text)';
          parentVal.textContent = parent;
          parentP.appendChild(parentLabel);
          parentP.appendChild(parentVal);
          details.appendChild(parentP);
        }
        const opts = options || {};
        if (!opts.hideDetails) {
        const assignChecked = opts.assign !== undefined ? opts.assign : (document.getElementById('assign-me')?.checked ?? true);
        const sp = opts.storyPoints !== undefined ? opts.storyPoints : (document.getElementById('story-points')?.value || '');
        const pri = opts.priority || '';

        const addDetail = (label, value) => {
          const p = document.createElement('p');
          p.style.cssText = 'font-size:0.85rem;margin-top:0.2rem;';
          const l = document.createElement('span');
          l.style.color = 'var(--text-muted)';
          l.textContent = label + ': ';
          const v = document.createElement('span');
          v.style.color = 'var(--text)';
          v.textContent = value;
          p.appendChild(l);
          p.appendChild(v);
          details.appendChild(p);
        };

        addDetail('Assignee', assignChecked ? 'You' : 'Unassigned');
        if (pri) addDetail('Priority', pri);
        if (sp !== 'n/a') {
          const spP = document.createElement('p');
          spP.style.cssText = 'font-size:0.85rem;margin-top:0.2rem;';
          if (sp) {
            const spLabel = document.createElement('span');
            spLabel.style.color = 'var(--text-muted)';
            spLabel.textContent = 'Story Points: ';
            const spVal = document.createElement('span');
            spVal.style.color = 'var(--text)';
            spVal.textContent = sp;
            spP.appendChild(spLabel);
            spP.appendChild(spVal);
          } else {
            spP.style.color = '#e3b341';
            spP.textContent = '⚠️ No story points set';
          }
          details.appendChild(spP);
        }
        } // end hideDetails check

        // Editable story points selector (for link/update flows)
        let spSelect = null;
        if (opts.spSelect) {
          const spRow = document.createElement('div');
          spRow.style.cssText = 'margin-top:0.5rem;display:flex;align-items:center;gap:0.5rem;font-size:0.85rem;';
          const spLabel = document.createElement('span');
          spLabel.style.color = 'var(--text-muted)';
          spLabel.textContent = 'Story Points:';
          spSelect = document.createElement('select');
          spSelect.style.cssText = 'padding:0.3rem 0.4rem;background:var(--bg1);color:var(--text);border:1px solid var(--border);border-radius:4px;font-size:0.85rem;';
          const spOptions = ['—', '1', '2', '3', '5', '8', '13', '21'];
          const currentSP = opts.spSelect.current;
          for (const v of spOptions) {
            const o = document.createElement('option');
            o.value = v === '—' ? '' : v;
            o.textContent = v;
            if (currentSP && String(currentSP) === v) o.selected = true;
            else if (!currentSP && v === '—') o.selected = true;
            spSelect.appendChild(o);
          }
          spRow.appendChild(spLabel);
          spRow.appendChild(spSelect);
          details.appendChild(spRow);
        }

        modal.appendChild(details);

        const actions = document.createElement('div');
        actions.className = 'modal-actions';
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'modal-btn cancel';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => { overlay.remove(); resolve(false); });
        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'modal-btn create';
        confirmBtn.textContent = opts.buttonText || (opts.hideDetails ? 'Confirm' : 'Create Ticket');
        confirmBtn.addEventListener('click', () => {
          overlay.remove();
          if (spSelect) {
            resolve({ confirmed: true, storyPoints: spSelect.value ? parseFloat(spSelect.value) : null });
          } else {
            resolve(true);
          }
        });
        actions.appendChild(cancelBtn);
        actions.appendChild(confirmBtn);
        modal.appendChild(actions);

        overlay.appendChild(modal);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve(false); } });
        document.body.appendChild(overlay);
        confirmBtn.focus();
      });
    }

    // Inline editing for ticket fields
    function closeAllDropdowns() {
      document.querySelectorAll('.jirassic-dropdown').forEach(d => d.remove());
    }

    function showDropdown(el, items) {
      closeAllDropdowns();
      const dropdown = document.createElement('div');
      dropdown.className = 'jirassic-dropdown';
      dropdown.style.cssText = 'position:fixed;background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:0.3rem;z-index:500;min-width:120px;box-shadow:0 8px 24px rgba(0,0,0,0.5);';
      for (const { label, onClick } of items) {
        const opt = document.createElement('div');
        opt.style.cssText = 'padding:0.4rem 0.6rem;cursor:pointer;font-size:0.85rem;border-radius:4px;color:var(--text);';
        opt.textContent = label;
        opt.addEventListener('mouseenter', () => opt.style.background = 'var(--bg3)');
        opt.addEventListener('mouseleave', () => opt.style.background = '');
        opt.addEventListener('click', async (e) => {
          e.stopPropagation();
          dropdown.remove();
          document.removeEventListener('click', closeHandler);
          await onClick();
        });
        dropdown.appendChild(opt);
      }
      const rect = el.getBoundingClientRect();
      dropdown.style.top = rect.bottom + 'px';
      dropdown.style.left = rect.left + 'px';
      document.body.appendChild(dropdown);
      const closeHandler = (e) => { if (!dropdown.contains(e.target) && e.target !== el) { dropdown.remove(); document.removeEventListener('click', closeHandler); } };
      setTimeout(() => document.addEventListener('click', closeHandler), 0);
    }

    async function updateAndRefresh(url, body, successMsg) {
      const result = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await result.json();
      if (data.ok) {
        showToast(successMsg);
        await fetch('/api/refresh', { method: 'POST' });
      } else {
        showToast('Error: ' + (data.error || 'unknown'));
      }
    }

    async function editStatus(key, currentStatus, el) {
      const resp = await fetch('/api/jira/transitions/' + key);
      const transitions = await resp.json();
      if (!transitions.length) { showToast('No transitions available'); return; }
      showDropdown(el, transitions.map(t => ({
        label: t.name,
        onClick: () => updateAndRefresh('/api/jira/transition', { key, transitionId: t.id }, key + ' → ' + t.name),
      })));
    }

    async function editPriority(key, el) {
      showDropdown(el, ['Blocker', 'Critical', 'Major', 'Normal', 'Minor'].map(p => ({
        label: p,
        onClick: () => updateAndRefresh('/api/jira/update', { key, fields: { priority: { name: p } } }, key + ' priority → ' + p),
      })));
    }

    async function editSummary(key, currentSummary, el) {
      const input = document.createElement('input');
      input.className = 'modal-input';
      input.value = currentSummary;
      input.style.cssText = 'margin:0;width:100%;';
      el.textContent = '';
      el.appendChild(input);
      input.focus();
      let saved = false;
      async function save() {
        if (saved) return;
        saved = true;
        const val = input.value.trim();
        if (!val || val === currentSummary) { el.textContent = currentSummary; return; }
        el.textContent = val;
        el.dataset.summary = val;
        const result = await fetch('/api/jira/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, fields: { summary: val } }),
        });
        const data = await result.json();
        if (data.ok) {
          showToast(key + ' summary updated');
        } else {
          el.textContent = currentSummary;
          el.dataset.summary = currentSummary;
          showToast('Error: ' + (data.error || 'unknown'));
        }
      }
      input.addEventListener('blur', save);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { saved = true; el.textContent = currentSummary; }
      });
    }

    async function editStoryPoints(key, el) {
      showDropdown(el, ['—', '1', '2', '3', '5', '8', '13', '21'].map(p => ({
        label: p,
        onClick: () => updateAndRefresh('/api/jira/update', { key, fields: { customfield_10028: p === '—' ? null : parseFloat(p) } }, key + ' story points → ' + (p === '—' ? 'none' : p)),
      })));
    }

        // Move to sprint (with future sprint picker)
    async function moveToNextSprint(key) {
      const ticket = DATA?.tickets?.find(t => t.key === key);
      const summary = ticket ? key + ': ' + ticket.summary : key;

      // Fetch future sprints
      let sprints = [];
      try {
        const r = await fetch('/api/jira/future-sprints');
        const d = await r.json();
        sprints = d.sprints || [];
      } catch {}
      if (!sprints.length) { showToast('No future sprints found'); return; }

      // Build modal with sprint dropdown
      const selectedSprint = await new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.style.zIndex = '400';
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.style.width = '400px'; modal.style.background = 'var(--bg2)';

        const h = document.createElement('h3');
        h.textContent = 'Move to sprint';
        modal.appendChild(h);

        const details = document.createElement('div');
        details.style.cssText = 'margin:1rem 0;font-size:0.9rem;';
        const summaryP = document.createElement('p');
        summaryP.style.cssText = 'margin-bottom:0.75rem;';
        const summaryLabel = document.createElement('span');
        summaryLabel.style.color = 'var(--text-muted)';
        summaryLabel.textContent = 'Summary: ';
        const summaryVal = document.createElement('span');
        summaryVal.style.color = 'var(--text-bright)';
        summaryVal.textContent = summary;
        summaryP.appendChild(summaryLabel);
        summaryP.appendChild(summaryVal);
        details.appendChild(summaryP);

        const selectLabel = document.createElement('label');
        selectLabel.style.cssText = 'color:var(--text-muted);font-size:0.85rem;display:block;margin-bottom:0.3rem;';
        selectLabel.textContent = 'Sprint:';
        details.appendChild(selectLabel);

        const select = document.createElement('select');
        select.style.cssText = 'width:100%;padding:0.4rem 0.5rem;background:var(--bg1);color:var(--text);border:1px solid var(--border);border-radius:4px;font-size:0.9rem;';
        const firstFutureIdx = sprints.findIndex(s => s.state === 'future');
        sprints.forEach((s, i) => {
          const opt = document.createElement('option');
          opt.value = s.id;
          opt.textContent = s.name + (s.state === 'active' ? ' (current)' : '');
          opt.selected = firstFutureIdx >= 0 ? i === firstFutureIdx : i === 0;
          select.appendChild(opt);
        });
        details.appendChild(select);
        modal.appendChild(details);

        const actions = document.createElement('div');
        actions.className = 'modal-actions';
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'modal-btn cancel';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => { overlay.remove(); resolve(null); });
        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'modal-btn create';
        confirmBtn.textContent = 'Move';
        confirmBtn.addEventListener('click', () => { overlay.remove(); resolve({ id: select.value, name: select.options[select.selectedIndex].text }); });
        actions.appendChild(cancelBtn);
        actions.appendChild(confirmBtn);
        modal.appendChild(actions);

        overlay.appendChild(modal);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve(null); } });
        document.body.appendChild(overlay);
        confirmBtn.focus();
      });

      if (!selectedSprint) return;

      const resp = await fetch('/api/jira/next-sprint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, sprintId: selectedSprint.id }),
      });
      const data = await resp.json();
      if (data.ok) {
        showToast(key + ' moved to ' + (data.sprint || selectedSprint.name));
        // If this was the last ticket in the current tab, switch back to current sprint
        if (activeTab !== 'sprint' && activeTab !== 'all') {
          const tabEl = document.getElementById('tab-' + activeTab);
          const ticketRows = tabEl ? tabEl.querySelectorAll('tr[data-toggle-epic], .epic-child:not([class*="standalone"])') : [];
          const ticketKeys = new Set();
          tabEl?.querySelectorAll('[data-move]').forEach(btn => ticketKeys.add(btn.dataset.move));
          ticketKeys.delete(key);
          if (ticketKeys.size === 0) activeTab = 'sprint';
        }
        // Brief delay — Jira's API can lag behind sprint moves
        setTimeout(() => fetch('/api/refresh', { method: 'POST' }), 1500);
      } else {
        showToast('Error: ' + (data.error || 'unknown'));
      }
    }

    // Quick create ticket/epic
    async function quickCreate(epicKey, isEpic) {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

      const modal = document.createElement('div');
      modal.className = 'modal';
      modal.style.width = '450px';

      const title = document.createElement('h3');
      let epicSummary = '';
      if (epicKey && DATA) {
        const epic = DATA.tickets.find(t => t.key === epicKey);
        if (epic) epicSummary = epic.summary;
        if (!epicSummary && parentCache[epicKey]) epicSummary = parentCache[epicKey].summary;
      }
      title.textContent = isEpic ? 'Create Epic' : (epicKey ? 'Add Task to ' + epicKey + (epicSummary ? ': ' + epicSummary : '') : 'Create Standalone Task');
      modal.appendChild(title);

      const summaryInput = document.createElement('input');
      summaryInput.className = 'modal-input';
      summaryInput.placeholder = 'Summary';
      modal.appendChild(summaryInput);

      const optionsDiv = document.createElement('div');
      optionsDiv.style.cssText = 'display:flex;gap:1.5rem;align-items:center;margin:0.5rem 0;';

      const assignLabel = document.createElement('label');
      assignLabel.style.cssText = 'display:flex;align-items:center;gap:0.4rem;color:var(--text);font-size:0.85rem;cursor:pointer;';
      const assignCheck = document.createElement('input');
      assignCheck.type = 'checkbox';
      assignCheck.checked = true;
      assignLabel.appendChild(assignCheck);
      assignLabel.appendChild(document.createTextNode('Assign to me'));
      optionsDiv.appendChild(assignLabel);

      const prLabel = document.createElement('label');
      prLabel.style.cssText = 'display:flex;align-items:center;gap:0.4rem;color:var(--text);font-size:0.85rem;';
      prLabel.appendChild(document.createTextNode('Priority'));
      const prSelect = document.createElement('select');
      prSelect.style.cssText = 'background:var(--bg);border:1px solid var(--border);color:var(--text);padding:2px 6px;border-radius:4px;font-size:0.85rem;';
      for (const v of ['Major', 'Blocker', 'Critical', 'Normal', 'Minor']) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v;
        prSelect.appendChild(opt);
      }
      prLabel.appendChild(prSelect);
      optionsDiv.appendChild(prLabel);
      modal.prSelect = prSelect;

      if (!isEpic) {
        const spLabel = document.createElement('label');
        spLabel.style.cssText = 'display:flex;align-items:center;gap:0.4rem;color:var(--text);font-size:0.85rem;';
        spLabel.appendChild(document.createTextNode('Story Points'));
        const spSelect = document.createElement('select');
        spSelect.style.cssText = 'background:var(--bg);border:1px solid var(--border);color:var(--text);padding:2px 6px;border-radius:4px;font-size:0.85rem;';
        for (const v of ['', '1', '2', '3', '5', '8', '13', '21']) {
          const opt = document.createElement('option');
          opt.value = v;
          opt.textContent = v || '—';
          spSelect.appendChild(opt);
        }
        const spWarn = document.createElement('span');
        spWarn.className = 'sp-warn';
        spWarn.title = 'No story points set';
        spWarn.textContent = '⚠️';
        spSelect.addEventListener('change', () => { spWarn.style.display = spSelect.value ? 'none' : ''; });
        spLabel.appendChild(spSelect);
        spLabel.appendChild(spWarn);
        optionsDiv.appendChild(spLabel);
        modal.spSelect = spSelect;
      }
      modal.appendChild(optionsDiv);

      const actions = document.createElement('div');
      actions.className = 'modal-actions';

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'modal-btn cancel';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => overlay.remove());

      const createBtn = document.createElement('button');
      createBtn.className = 'modal-btn create';
      createBtn.textContent = isEpic ? 'Create Epic' : 'Create Task';
      createBtn.addEventListener('click', async () => {
        const summary = summaryInput.value.trim();
        if (!summary) { summaryInput.style.borderColor = '#da3633'; summaryInput.focus(); return; }
        const sp = modal.spSelect?.value || null;
        const assign = assignCheck.checked;

        const priority = modal.prSelect?.value || 'Major';
        const typeName = isEpic ? 'Epic' : 'Task';
        if (!await confirmCreate('Create ' + typeName + '?', summary, epicKey ? epicKey + (epicSummary ? ': ' + epicSummary : '') : null, { assign, storyPoints: isEpic ? 'n/a' : (sp || ''), priority })) return;
        const body = { summary, assignToMe: assign, priority };
        if (epicKey && !isEpic) body.epicKey = epicKey;
        if (sp) body.storyPoints = sp;

        // For epics, we need a different issue type
        const url = isEpic ? '/api/jira/create-epic' : '/api/jira/create';
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const result = await resp.json();
        if (result.ok) {
          showToast('Created ' + result.key);
          overlay.remove();
          setTimeout(() => fetch('/api/refresh', { method: 'POST' }), 1500);
        } else {
          showToast('Error: ' + (result.error || 'unknown'));
        }
      });

      summaryInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') createBtn.click(); });

      actions.appendChild(cancelBtn);
      actions.appendChild(createBtn);
      modal.appendChild(actions);

      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      summaryInput.focus();
    }

    // Ticket browser modal
    function openTicketBrowser(hash, text, meeting, parentOverlay) {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.style.zIndex = '300';
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

      const modal = document.createElement('div');
      modal.className = 'modal';
      modal.style.width = '700px'; modal.style.background = 'var(--bg2)';

      const title = document.createElement('h3');
      title.textContent = 'Browse Tickets';
      modal.appendChild(title);

      const searchInput = document.createElement('input');
      searchInput.className = 'modal-input';
      searchInput.placeholder = 'Filter by key or summary...';
      searchInput.style.marginBottom = '0.5rem';
      modal.appendChild(searchInput);

      const listEl = document.createElement('div');
      listEl.className = 'epic-list';
      listEl.style.maxHeight = '400px';

      function renderList(filter) {
        listEl.textContent = '';
        const allTickets = DATA?.tickets || [];
        const filtered = filter
          ? allTickets.filter(t => t.key.toLowerCase().includes(filter) || t.summary.toLowerCase().includes(filter))
          : allTickets;

        if (!filtered.length) {
          const empty = document.createElement('div');
          empty.style.cssText = 'color:#484f58;text-align:center;padding:1rem;font-size:0.85rem;';
          empty.textContent = 'No matching tickets';
          listEl.appendChild(empty);
          return;
        }

        for (const t of filtered) {
          const item = document.createElement('div');
          item.className = 'epic-item';
          const keySpan = document.createElement('span');
          keySpan.className = 'epic-key';
          keySpan.style.minWidth = '140px';
          keySpan.textContent = t.key;
          if (t.type === 'Epic') {
            const epicBadge = document.createElement('span');
            epicBadge.className = 'badge epic';
            epicBadge.textContent = 'EPIC';
            epicBadge.style.marginLeft = '0.3rem';
            keySpan.appendChild(epicBadge);
          }
          const summarySpan = document.createElement('span');
          summarySpan.className = 'epic-summary';
          summarySpan.style.flex = '1';
          summarySpan.textContent = t.summary;
          const statusSpan = document.createElement('span');
          const sc = t.status.toLowerCase().replace(/ /g, '-');
          statusSpan.className = 'badge status-' + sc;
          statusSpan.style.cssText = 'flex-shrink:0;';
          statusSpan.textContent = t.status;
          item.appendChild(keySpan);
          item.appendChild(summarySpan);
          item.appendChild(statusSpan);
          item.addEventListener('click', async () => {
            const result = await confirmCreate('Link action item to ' + t.key + '?', text, t.key + ': ' + t.summary, {
              buttonText: 'Update Ticket',
              hideDetails: true,
              spSelect: { current: t.story_points || null },
            });
            if (!result) return;
            // Update story points if changed
            if (result.storyPoints !== undefined) {
              const currentSP = t.story_points || null;
              const newSP = result.storyPoints;
              if (newSP !== currentSP) {
                await fetch('/api/jira/update', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ key: t.key, fields: { customfield_10028: newSP } }),
                });
              }
            }
            await triageItem(hash, 'jira', t.key, text, meeting);
            overlay.remove();
            if (parentOverlay) parentOverlay.remove();
          });
          listEl.appendChild(item);
        }
      }

      searchInput.addEventListener('input', () => {
        renderList(searchInput.value.trim().toLowerCase());
      });

      renderList('');
      modal.appendChild(listEl);

      const actions = document.createElement('div');
      actions.className = 'modal-actions';
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'modal-btn cancel';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => overlay.remove());
      actions.appendChild(cancelBtn);
      modal.appendChild(actions);

      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      searchInput.focus();
    }

    // Jira modal
    let jiraEpics = null;
    async function loadEpics() {
      if (jiraEpics) return jiraEpics;
      const resp = await fetch('/api/jira/epics');
      jiraEpics = await resp.json();
      return jiraEpics;
    }

    async function openJiraModal(hash, originalText, meeting) {
      let text = originalText;
      const epics = await loadEpics();

      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

      let epicListHtml = '';
      for (const e of epics) {
        epicListHtml += '<div class="epic-item" data-epic-key="' + esc(e.key) + '"><span class="epic-key">' + esc(e.key) + '</span> <span class="epic-summary">' + esc(e.summary) + '</span></div>';
      }

      const modal = document.createElement('div');
      modal.className = 'modal';

      const contextDiv = document.createElement('div');
      contextDiv.className = 'modal-context';
      contextDiv.contentEditable = 'true';
      contextDiv.style.cssText += 'cursor:text;border:1px solid transparent;padding:0.5rem;';
      contextDiv.textContent = text;
      contextDiv.title = 'Click to edit';
      contextDiv.addEventListener('focus', () => { contextDiv.style.borderColor = '#30363d'; });
      contextDiv.addEventListener('blur', () => { contextDiv.style.borderColor = 'transparent'; text = contextDiv.textContent; });

      const titleEl = document.createElement('h3');
      titleEl.textContent = 'Create Jira Ticket';

      modal.appendChild(titleEl);
      modal.appendChild(contextDiv);

      // Options row: assign + story points
      const optionsDiv = document.createElement('div');
      optionsDiv.style.cssText = 'display:flex;gap:1.5rem;align-items:center;margin-bottom:1rem;padding:0.5rem;background:#0d1117;border-radius:4px;';

      const assignLabel = document.createElement('label');
      assignLabel.style.cssText = 'display:flex;align-items:center;gap:0.4rem;color:#c9d1d9;font-size:0.85rem;cursor:pointer;';
      const assignCheck = document.createElement('input');
      assignCheck.type = 'checkbox';
      assignCheck.id = 'assign-me';
      assignCheck.checked = true;
      assignLabel.appendChild(assignCheck);
      assignLabel.appendChild(document.createTextNode('Assign to me'));
      optionsDiv.appendChild(assignLabel);

      const spLabel = document.createElement('label');
      spLabel.style.cssText = 'display:flex;align-items:center;gap:0.4rem;color:#c9d1d9;font-size:0.85rem;';
      spLabel.appendChild(document.createTextNode('Story Points'));
      const spSelect = document.createElement('select');
      spSelect.id = 'story-points';
      spSelect.style.cssText = 'background:var(--bg);border:1px solid var(--border);color:var(--text);padding:2px 6px;border-radius:4px;font-size:0.85rem;';
      const spOptions = ['', '1', '2', '3', '5', '8', '13', '21'];
      for (const v of spOptions) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v || '—';
        spSelect.appendChild(opt);
      }
      const spWarn2 = document.createElement('span');
      spWarn2.className = 'sp-warn';
      spWarn2.title = 'No story points set';
      spWarn2.textContent = '⚠️';
      spSelect.addEventListener('change', () => { spWarn2.style.display = spSelect.value ? 'none' : ''; });
      spLabel.appendChild(spSelect);
      spLabel.appendChild(spWarn2);
      optionsDiv.appendChild(spLabel);

      modal.appendChild(optionsDiv);

      // Section 1: Add to an epic
      if (epics.length) {
        const divider1 = document.createElement('div');
        divider1.className = 'or-divider';
        divider1.textContent = '— add as a task under an epic —';
        modal.appendChild(divider1);

        const epicSection = document.createElement('div');
        epicSection.className = 'modal-section';
        const epicTitle = document.createElement('h4');
        epicTitle.textContent = 'Your Epics';
        epicSection.appendChild(epicTitle);
        const epicListEl = document.createElement('div');
        epicListEl.className = 'epic-list';

        for (const ep of epics) {
          const item = document.createElement('div');
          item.className = 'epic-item';
          const keySpan = document.createElement('span');
          keySpan.className = 'epic-key';
          keySpan.textContent = ep.key;
          const summarySpan = document.createElement('span');
          summarySpan.className = 'epic-summary';
          summarySpan.textContent = ep.summary;
          item.appendChild(keySpan);
          item.appendChild(summarySpan);
          item.addEventListener('click', async () => {
            const summary = text.length > 100 ? text.substring(0, 100) + '...' : text;
            const assignToMe = document.getElementById('assign-me')?.checked ?? true;
            const storyPoints = document.getElementById('story-points')?.value || null;
            if (!await confirmCreate('Create task under ' + ep.key + '?', summary, ep.key + ': ' + ep.summary, { assign: assignToMe, storyPoints: storyPoints || '', priority: '' })) return;
            const resp = await fetch('/api/jira/create', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ summary, epicKey: ep.key, description: text, assignToMe, storyPoints }),
            });
            const result = await resp.json();
            if (result.ok) {
              await triageItem(hash, 'jira', result.key, text, meeting);
              showToast('Created ' + result.key + ' under ' + ep.key);
              overlay.remove();
            } else {
              showToast('Error: ' + (result.error || 'unknown'));
            }
          });
          epicListEl.appendChild(item);
        }
        epicSection.appendChild(epicListEl);
        modal.appendChild(epicSection);
      }

      // Section 3: Create standalone ticket
      const divider2 = document.createElement('div');
      divider2.className = 'or-divider';
      divider2.textContent = '— or create as a standalone ticket —';
      modal.appendChild(divider2);

      const newSection = document.createElement('div');
      newSection.className = 'modal-section';
      const newBtn = document.createElement('button');
      newBtn.className = 'modal-btn create';
      newBtn.textContent = 'Create Standalone Ticket';
      newBtn.addEventListener('click', async () => {
        const summary = contextDiv.textContent.trim();
        if (!summary) { contextDiv.style.borderColor = '#da3633'; contextDiv.focus(); return; }
        const assignToMe = document.getElementById('assign-me')?.checked ?? true;
        const storyPoints = document.getElementById('story-points')?.value || null;
        if (!await confirmCreate('Create standalone ticket?', summary, null, { assign: assignToMe, storyPoints: storyPoints || '' })) return;
        const resp = await fetch('/api/jira/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ summary, description: text, assignToMe, storyPoints }),
        });
        const result = await resp.json();
        if (result.ok) {
          await triageItem(hash, 'jira', result.key, text, meeting);
          showToast('Created ' + result.key);
          overlay.remove();
        } else {
          showToast('Error: ' + (result.error || 'unknown'));
        }
      });
      newSection.appendChild(newBtn);
      modal.appendChild(newSection);

      // Cancel
      const actions = document.createElement('div');
      actions.className = 'modal-actions';
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'modal-btn cancel';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => overlay.remove());
      actions.appendChild(cancelBtn);
      modal.appendChild(actions);

      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      existingInput.focus();
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
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.toggle('collapsed');
      const isExpanded = !el.classList.contains('collapsed');
      expandedState[id] = isExpanded;
      const arrow = document.getElementById(arrowId);
      if (arrow) arrow.textContent = isExpanded ? '\\u25BC' : '\\u25B6';
    }

    // --- Render ticket table ---
    let tableCounter = 0;
    function renderTicketTable(tickets) {
      if (!tickets || !tickets.length) return '<p class="empty">No tickets</p>';
      const tbl = tableCounter++;
      const epicInfo = {}, epicChildren = {}, standalone = [];
      for (const t of tickets) {
        if (t.type === 'Epic') { epicInfo[t.key] = t; epicChildren[t.key] = epicChildren[t.key] || []; }
        else if (t.parent) { epicChildren[t.parent] = epicChildren[t.parent] || []; epicChildren[t.parent].push(t); }
        else standalone.push(t);
      }
      let rows = '';
      let epicIdx = 0;
      for (const [key, children] of Object.entries(epicChildren)) {
        const eid = 'epic-t' + tbl + '-' + (epicIdx++) + '-' + key.replace(/[^a-zA-Z0-9]/g, '');
        const info = epicInfo[key];
        const childCount = children.length;
        if (info) {
          const sc = info.status.toLowerCase().replace(/ /g, '-');
          const epicSP = children.reduce((sum, c) => sum + (c.story_points || 0), 0);
          const missingChildSPCount = children.filter(c => !c.story_points).length;
          const epicSPDisplay = (epicSP ? epicSP : '') + (missingChildSPCount ? '<span class="sp-warn-epic" title="' + missingChildSPCount + ' task' + (missingChildSPCount > 1 ? 's' : '') + ' missing story points">' + missingChildSPCount + '</span>' : '');
          rows += '<tr class="epic-row" data-toggle-epic="' + eid + '"><td><span class="epic-arrow" id="arrow-' + eid + '">\\u25B6</span>' + jiraLink(info.key) + '<span class="badge epic">EPIC</span><button class="move-btn" data-move="' + esc(info.key) + '" title="Move to next sprint">→</button></td><td class="editable-summary" data-key="' + esc(info.key) + '" data-summary="' + esc(info.summary) + '" style="cursor:pointer">' + esc(info.summary) + ' <span style="color:#484f58;font-size:0.8rem">(' + childCount + ')</span></td><td class="editable-status" data-key="' + esc(info.key) + '" style="cursor:pointer"><span class="badge status-' + sc + '">' + esc(info.status) + '</span></td><td class="editable-priority" data-key="' + esc(info.key) + '" style="cursor:pointer">' + esc(info.priority) + '</td><td>' + epicSPDisplay + '</td></tr>';
        } else {
          const cached = parentCache[key];
          const parentInfo = parentCache[key];
          const parentLabel = parentInfo ? esc(parentInfo.summary) : esc(key);
          const epicSP2 = children.reduce((sum, c) => sum + (c.story_points || 0), 0);
          const missingChildSPCount2 = children.filter(c => !c.story_points).length;
          const epicSPDisplay2 = (epicSP2 ? epicSP2 : '') + (missingChildSPCount2 ? '<span class="sp-warn-epic" title="' + missingChildSPCount2 + ' task' + (missingChildSPCount2 > 1 ? 's' : '') + ' missing story points">' + missingChildSPCount2 + '</span>' : '');
          const parentData = parentCache[key];
          const isClosed = parentData?.status === 'Closed' || parentData?.status === 'Done';
          const moveBtn2 = isClosed ? '' : '<button class="move-btn" data-move="' + esc(key) + '" title="Move to next sprint">→</button>';
          const parentStatus = parentData?.status || '';
          const parentSc = parentStatus.toLowerCase().replace(/ /g, '-');
          const statusCell = parentStatus ? '<span class="badge status-' + parentSc + '">' + esc(parentStatus) + '</span>' : '';
          rows += '<tr class="epic-row" data-toggle-epic="' + eid + '"><td><span class="epic-arrow" id="arrow-' + eid + '">\\u25B6</span>' + jiraLink(key) + '<span class="badge epic">EPIC</span>' + moveBtn2 + '</td><td>' + parentLabel + ' <span style="color:#484f58;font-size:0.8rem">(' + childCount + ')</span></td><td>' + statusCell + '</td><td></td><td>' + epicSPDisplay2 + '</td></tr>';
        }
        for (const c of children) {
          const sc = c.status.toLowerCase().replace(/ /g, '-');
          const isClosed = c.status === 'Closed' || c.status === 'Done';
          const closedClass = isClosed ? ' ticket-closed' : '';
          const spDisplay = c.story_points ? c.story_points : '<span class="sp-warn" title="No story points set">⚠️</span>';
          rows += '<tr class="epic-child ' + eid + closedClass + '" style="display:none"><td>' + jiraLink(c.key) + (isClosed ? '' : '<button class="move-btn" data-move="' + esc(c.key) + '" title="Move to next sprint">→</button>') + '</td><td class="editable-summary" data-key="' + esc(c.key) + '" data-summary="' + esc(c.summary) + '" style="cursor:pointer">' + esc(c.summary) + '</td><td class="editable-status" data-key="' + esc(c.key) + '" style="cursor:pointer"><span class="badge status-' + sc + '">' + esc(c.status) + '</span></td><td class="editable-priority" data-key="' + esc(c.key) + '" style="cursor:pointer">' + esc(c.priority) + '</td><td class="editable-sp" data-key="' + esc(c.key) + '" style="cursor:pointer">' + spDisplay + '</td></tr>';
        }
        const epicKeyForAdd = info ? info.key : key;
        rows += '<tr class="epic-child ' + eid + '" style="display:none"><td colspan="5" style="padding-left:2.5rem"><button class="add-btn" data-add-task="' + esc(epicKeyForAdd) + '">+ Add Task</button></td></tr>';
      }
      if (standalone.length) {
        const sid = 'epic-t' + tbl + '-standalone-' + epicIdx;
        const standaloneSP = standalone.reduce((sum, t) => sum + (t.story_points || 0), 0);
        const standaloneMissingSP = standalone.filter(t => !t.story_points).length;
        const standaloneSPDisplay = (standaloneSP ? standaloneSP : '') + (standaloneMissingSP ? '<span class="sp-warn-epic" title="' + standaloneMissingSP + ' task' + (standaloneMissingSP > 1 ? 's' : '') + ' missing story points">' + standaloneMissingSP + '</span>' : '');
        rows += '<tr class="epic-row" data-toggle-epic="' + sid + '"><td><span class="epic-arrow" id="arrow-' + sid + '">\\u25B6</span>Standalone <span style="color:#484f58;font-size:0.8rem">(' + standalone.length + ')</span></td><td></td><td></td><td></td><td>' + standaloneSPDisplay + '</td></tr>';
        for (const t of standalone) {
          const sc = t.status.toLowerCase().replace(/ /g, '-');
          const isClosed = t.status === 'Closed' || t.status === 'Done';
          const closedClass = isClosed ? ' ticket-closed' : '';
          const spDisplay = t.story_points ? t.story_points : '<span class="sp-warn" title="No story points set">⚠️</span>';
          rows += '<tr class="epic-child ' + sid + closedClass + '" style="display:none"><td>' + jiraLink(t.key) + (isClosed ? '' : '<button class="move-btn" data-move="' + esc(t.key) + '" title="Move to next sprint">→</button>') + '</td><td class="editable-summary" data-key="' + esc(t.key) + '" data-summary="' + esc(t.summary) + '" style="cursor:pointer">' + esc(t.summary) + '</td><td class="editable-status" data-key="' + esc(t.key) + '" style="cursor:pointer"><span class="badge status-' + sc + '">' + esc(t.status) + '</span></td><td class="editable-priority" data-key="' + esc(t.key) + '" style="cursor:pointer">' + esc(t.priority) + '</td><td class="editable-sp" data-key="' + esc(t.key) + '" style="cursor:pointer">' + spDisplay + '</td></tr>';
        }
        rows += '<tr class="epic-child ' + sid + '" style="display:none"><td colspan="5" style="padding-left:2.5rem"><button class="add-btn" data-add-task="">+ Add Task</button></td></tr>';
      }
      rows += '<tr><td colspan="5"><button class="add-btn" data-add-epic="true">+ Add Epic</button></td></tr>';
      const nonEpicTickets = tickets.filter(t => t.type !== 'Epic');
      const totalSP = nonEpicTickets.reduce((sum, t) => sum + (t.story_points || 0), 0);
      const noSP = nonEpicTickets.every(t => !t.story_points);
      let spClass = 'sp-green';
      if (noSP && tickets.length) spClass = 'sp-none';
      else if (totalSP > 34) spClass = 'sp-red';
      else if (totalSP > 21) spClass = 'sp-yellow';
      const spTooltip = noSP ? 'No story points set on any tickets' : (totalSP > 34 ? 'Overloaded (35+)' : totalSP > 21 ? 'Heavy sprint (22-34)' : 'Comfortable capacity (0-21)');
      const spFooter = '<div style="text-align:right;margin-top:0.3rem;"><span class="sp-total ' + spClass + '" title="' + spTooltip + '">Total Story Points: ' + totalSP + '</span></div>';
      return '<table><tr><th>Ticket</th><th>Summary</th><th>Status</th><th>Priority</th><th>SP</th></tr>' + rows + '</table>' + spFooter;
    }

    // --- Collapse state ---
    function saveCollapseState() {
      // Save epic expand states
      document.querySelectorAll('[data-toggle-epic]').forEach(row => {
        const eid = row.dataset.toggleEpic;
        const children = document.querySelectorAll('.' + eid);
        if (children.length) {
          expandedState['epic-' + eid] = children[0].style.display !== 'none';
        }
      });
      // Save section collapse states
      ['triaged-section', 'jira-items', 'skip-items'].forEach(id => {
        const el = document.getElementById(id);
        if (el) expandedState[id] = !el.classList.contains('collapsed');
      });
    }

    function restoreCollapseState() {
      // Restore epic states
      for (const [id, isExpanded] of Object.entries(expandedState)) {
        if (id.startsWith('epic-')) {
          const eid = id.slice(5);
          const children = document.querySelectorAll('.' + eid);
          const arrow = document.getElementById('arrow-' + eid);
          if (isExpanded) {
            children.forEach(c => c.style.display = '');
            if (arrow) arrow.textContent = '\\u25BC';
          }
        }
      }
      // Restore section states
      ['triaged-section', 'jira-items', 'skip-items'].forEach(id => {
        if (expandedState[id]) {
          const el = document.getElementById(id);
          if (el) el.classList.remove('collapsed');
        }
      });
      // Restore arrows
      if (expandedState['triaged-section']) {
        const a = document.getElementById('triaged-arrow');
        if (a) a.textContent = '\\u25BC';
      }
      if (expandedState['jira-items']) {
        const a = document.getElementById('jira-arrow');
        if (a) a.textContent = '\\u25BC';
      }
      if (expandedState['skip-items']) {
        const a = document.getElementById('skip-arrow');
        if (a) a.textContent = '\\u25BC';
      }
    }

    // --- Main render ---
    function render() {
      if (!DATA) return;
      saveCollapseState();
      tableCounter = 0;
      document.getElementById('updated').textContent = 'Updated: ' + new Date(DATA.updated).toLocaleString();

      const { newItems, triagedItems, sprintTickets, sprintName, sprintStart, sprintEnd, lastSprintTickets, lastSprintName, futureSprints, backlogTickets, tickets } = DATA;
      const app = document.getElementById('app');

      let html = '<h2>My New Action Items (' + newItems.length + ')</h2>';

      if (newItems.length) {
        html += '<table><tr><th></th><th>Meeting</th><th>Action Item</th><th>Triage</th></tr>';
        for (const item of newItems) {
          const inputId = 'jira-' + item.hash;
          html += '<tr><td><span class="badge new">NEW</span></td>'
            + '<td>' + esc(item.meeting) + '</td>'
            + '<td>' + esc(item.text) + '</td>'
            + '<td><div class="triage-actions">'
            + '<button class="triage-btn skip-btn" data-action="skip" data-hash="' + item.hash + '" data-text="' + esc(item.text) + '" data-meeting="' + esc(item.meeting) + '">No Ticket Needed/Ignore</button>'
            + '<button class="triage-btn jira-btn" data-open-jira="create" data-hash="' + item.hash + '" data-text="' + esc(item.text) + '" data-meeting="' + esc(item.meeting) + '">Create Jira Ticket</button>'
            + '<button class="triage-btn jira-btn" data-open-jira="link" data-hash="' + item.hash + '" data-text="' + esc(item.text) + '" data-meeting="' + esc(item.meeting) + '">Link Jira Ticket</button>'
            + '</div></td></tr>';
        }
        html += '</table>';
      } else {
        html += '<p class="empty">No new action items</p>';
      }

      // Tickets
      html += '<h2>My Jira Tickets</h2>';
      html += '<div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.5rem;align-items:center;">';
      html += '<input type="text" id="ticket-search" placeholder="Search tickets..." style="flex:1;min-width:200px;max-width:400px;padding:0.4rem 0.6rem;background:var(--bg1);color:var(--text);border:1px solid var(--border);border-radius:4px;font-size:0.9rem;" />';
      // Collect unique statuses and priorities from all tickets
      const allStatuses = [...new Set(tickets.map(t => t.status))].sort();
      const allPriorities = [...new Set(tickets.map(t => t.priority).filter(p => p && p !== '—'))].sort();
      const statusCount = ticketStatusFilters.size;
      html += '<div class="multi-select" id="ms-status"><button class="multi-select-btn" type="button">Status' + (statusCount ? ' <span class="count">' + statusCount + '</span>' : '') + '</button><div class="multi-select-menu">';
      for (const s of allStatuses) html += '<label><input type="checkbox" value="' + esc(s) + '"' + (ticketStatusFilters.has(s) ? ' checked' : '') + '>' + esc(s) + '</label>';
      html += '</div></div>';
      const priCount = ticketPriorityFilters.size;
      html += '<div class="multi-select" id="ms-priority"><button class="multi-select-btn" type="button">Priority' + (priCount ? ' <span class="count">' + priCount + '</span>' : '') + '</button><div class="multi-select-menu">';
      for (const p of allPriorities) html += '<label><input type="checkbox" value="' + esc(p) + '"' + (ticketPriorityFilters.has(p) ? ' checked' : '') + '>' + esc(p) + '</label>';
      html += '</div></div>';
      html += '</div>';
      const countTasks = (arr) => arr.filter(t => t.type !== 'Epic').length;

      if (DATA.sprintsEnabled) {
        html += '<div class="tabs">';
        html += '<div class="tab' + (activeTab === 'sprint' ? ' active' : '') + '" data-tab="sprint">Current: ' + esc(sprintName || 'None') + ' (' + countTasks(sprintTickets) + ')</div>';
        const fs = futureSprints || [];
        for (let i = 0; i < fs.length; i++) {
          const tabId = 'future-' + i;
          html += '<div class="tab' + (activeTab === tabId ? ' active' : '') + '" data-tab="' + tabId + '">Next: ' + esc(fs[i].name) + ' (' + countTasks(fs[i].tickets) + ')</div>';
        }
        html += '<div class="tab' + (activeTab === 'last-sprint' ? ' active' : '') + '" data-tab="last-sprint">Last: ' + esc(lastSprintName || 'None') + ' (' + countTasks(lastSprintTickets) + ')</div>';
        html += '<div class="tab' + (activeTab === 'backlog' ? ' active' : '') + '" data-tab="backlog">Backlog (' + countTasks(backlogTickets) + ')</div>';
        html += '<div class="tab' + (activeTab === 'all' ? ' active' : '') + '" data-tab="all">All Open (' + countTasks(tickets) + ')</div>';
        html += '</div>';
        // Sprint progress bar
        let sprintProgressHtml = '';
        if (sprintStart && sprintEnd) {
          const start = new Date(sprintStart).getTime();
          const end = new Date(sprintEnd).getTime();
          const now = Date.now();
          const total = end - start;
          const elapsed = Math.max(0, Math.min(now - start, total));
          const pct = Math.round((elapsed / total) * 100);
          const daysLeft = Math.max(0, Math.ceil((end - now) / 86400000));
          const barColor = pct > 85 ? '#da3633' : pct > 60 ? '#e3b341' : '#238636';
          sprintProgressHtml = '<div class="sprint-info"><span>' + daysLeft + ' day' + (daysLeft !== 1 ? 's' : '') + ' remaining in sprint</span><span>' + pct + '% elapsed</span></div>'
            + '<div class="sprint-bar"><div class="sprint-bar-fill" style="width:' + pct + '%;background:' + barColor + '"></div></div>';
        }
        html += '<div class="tab-content' + (activeTab === 'sprint' ? ' active' : '') + '" id="tab-sprint">' + sprintProgressHtml + renderTicketTable(sprintTickets) + '</div>';
        for (let i = 0; i < fs.length; i++) {
          const tabId = 'future-' + i;
          html += '<div class="tab-content' + (activeTab === tabId ? ' active' : '') + '" id="tab-' + tabId + '">' + renderTicketTable(fs[i].tickets) + '</div>';
        }
        html += '<div class="tab-content' + (activeTab === 'last-sprint' ? ' active' : '') + '" id="tab-last-sprint">' + renderTicketTable(lastSprintTickets) + '</div>';
        html += '<div class="tab-content' + (activeTab === 'backlog' ? ' active' : '') + '" id="tab-backlog">' + renderTicketTable(backlogTickets) + '</div>';
        html += '<div class="tab-content' + (activeTab === 'all' ? ' active' : '') + '" id="tab-all">' + renderTicketTable(tickets) + '</div>';
      } else {
        // No sprints — show all tickets in a single flat view
        html += renderTicketTable(tickets);
      }

      // Triaged
      const jiraItems = triagedItems.filter(i => i.triaged?.status === 'jira');
      const skipItems = triagedItems.filter(i => i.triaged?.status !== 'jira');

      // Build ticket lookup for summaries
      const ticketLookup = {};
      for (const t of tickets) { ticketLookup[t.key] = t.summary; }

      html += '<h2><span class="toggle" id="triaged-toggle">Triaged Action Items (' + triagedItems.length + ') <span class="arrow" id="triaged-arrow">\\u25B6</span></span></h2>';
      html += '<div id="triaged-section" class="collapsed">';

      if (jiraItems.length) {
        html += '<h3><span class="toggle" id="jira-toggle">Linked to Jira (' + jiraItems.length + ') <span class="arrow" id="jira-arrow">\\u25B6</span></span></h3>';
        html += '<div id="jira-items" class="collapsed"><table><tr><th>Ticket</th><th>Meeting</th><th>Action Item</th><th></th></tr>';
        for (const i of jiraItems) {
          const ticket = i.triaged.ticket || '';
          const ticketTitle = i.triaged.ticketSummary || ticketLookup[ticket] || '';
          const ticketDisplay = ticket ? jiraLink(ticket) + (ticketTitle ? ' <span style="color:#8b949e;font-size:0.8rem">' + esc(ticketTitle) + '</span>' : '') : 'jira';
          html += '<tr><td>' + ticketDisplay + '</td><td>' + esc(i.meeting) + '</td><td>' + esc(i.text) + '</td><td><button class="triage-btn undo-btn" data-undo="' + i.hash + '">Undo</button></td></tr>';
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

      app.querySelectorAll('[data-toggle-epic]').forEach(row => {
        const eid = row.dataset.toggleEpic;
        const arrow = document.getElementById('arrow-' + eid);
        if (arrow) {
          arrow.addEventListener('click', (e) => {
            e.stopPropagation();
            const children = app.querySelectorAll('.' + eid);
            const visible = children[0]?.style.display !== 'none';
            children.forEach(c => c.style.display = visible ? 'none' : '');
            expandedState['epic-' + eid] = !visible;
            arrow.textContent = visible ? '\\u25B6' : '\\u25BC';
          });
        }
      });

      restoreCollapseState();

      // Ticket search and filter controls
      const searchBox = document.getElementById('ticket-search');
      if (searchBox) {
        searchBox.value = ticketSearchTerm || '';
        searchBox.addEventListener('input', () => {
          ticketSearchTerm = searchBox.value.trim().toLowerCase();
          filterTicketRows();
        });
      }
      // Multi-select dropdowns
      document.querySelectorAll('.multi-select').forEach(ms => {
        const btn = ms.querySelector('.multi-select-btn');
        const menu = ms.querySelector('.multi-select-menu');
        const isStatus = ms.id === 'ms-status';
        const filterSet = isStatus ? ticketStatusFilters : ticketPriorityFilters;
        const label = isStatus ? 'Status' : 'Priority';
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          document.querySelectorAll('.multi-select-menu.open').forEach(m => { if (m !== menu) m.classList.remove('open'); });
          menu.classList.toggle('open');
        });
        menu.querySelectorAll('input[type="checkbox"]').forEach(cb => {
          cb.addEventListener('change', () => {
            if (cb.checked) filterSet.add(cb.value);
            else filterSet.delete(cb.value);
            const count = filterSet.size;
            btn.textContent = '';
            btn.appendChild(document.createTextNode(label));
            if (count) {
              const badge = document.createElement('span');
              badge.className = 'count';
              badge.textContent = count;
              btn.appendChild(badge);
            }
            filterTicketRows();
          });
        });
      });
      document.addEventListener('click', () => {
        document.querySelectorAll('.multi-select-menu.open').forEach(m => m.classList.remove('open'));
      });
      filterTicketRows();

      // Move to next sprint buttons
      app.querySelectorAll('[data-move]').forEach(btn => {
        btn.addEventListener('click', (e) => { e.stopPropagation(); moveToNextSprint(btn.dataset.move); });
      });

      // Quick add buttons
      app.querySelectorAll('[data-add-task]').forEach(btn => {
        btn.addEventListener('click', (e) => { e.stopPropagation(); quickCreate(btn.dataset.addTask || '', false); });
      });
      app.querySelectorAll('[data-add-epic]').forEach(btn => {
        btn.addEventListener('click', (e) => { e.stopPropagation(); quickCreate('', true); });
      });

      // Editable ticket fields
      app.querySelectorAll('.editable-status').forEach(el => {
        el.addEventListener('click', (e) => { e.stopPropagation(); editStatus(el.dataset.key, '', el); });
      });
      app.querySelectorAll('.editable-priority').forEach(el => {
        el.addEventListener('click', (e) => { e.stopPropagation(); editPriority(el.dataset.key, el); });
      });
      app.querySelectorAll('.editable-summary').forEach(el => {
        el.addEventListener('click', (e) => { e.stopPropagation(); editSummary(el.dataset.key, el.dataset.summary, el); });
      });
      app.querySelectorAll('.editable-sp').forEach(el => {
        el.addEventListener('click', (e) => { e.stopPropagation(); editStoryPoints(el.dataset.key, el); });
      });

      app.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const action = btn.dataset.action;
          const label = 'No ticket needed — ignore this action item?';
          if (!await confirmCreate(label, btn.dataset.text, null, { hideDetails: true })) return;
          triageItem(btn.dataset.hash, action, '', btn.dataset.text, btn.dataset.meeting);
        });
      });
      app.querySelectorAll('[data-open-jira]').forEach(btn => {
        btn.addEventListener('click', () => {
          if (btn.dataset.openJira === 'link') {
            openTicketBrowser(btn.dataset.hash, btn.dataset.text, btn.dataset.meeting, null);
          } else {
            openJiraModal(btn.dataset.hash, btn.dataset.text, btn.dataset.meeting);
          }
        });
      });
      app.querySelectorAll('[data-undo]').forEach(btn => {
        btn.addEventListener('click', () => unTriageItem(btn.dataset.undo));
      });
    }

    // Theme toggle
    const savedTheme = localStorage.getItem('jirassic-theme') || 'dark';
    if (savedTheme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
      document.getElementById('theme-toggle').textContent = '🌙 Dark';
    }
    document.getElementById('theme-toggle').addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme');
      const next = current === 'light' ? '' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      document.getElementById('theme-toggle').textContent = next === 'light' ? '🌙 Dark' : '☀️ Light';
      localStorage.setItem('jirassic-theme', next || 'dark');
    });

    // Health check
    async function checkHealth() {
      try {
        const resp = await fetch('/api/health');
        const h = await resp.json();
        document.getElementById('jira-status').className = 'status-dot ' + (h.jira?.ok ? 'connected' : 'disconnected');
        document.getElementById('jira-label').textContent = h.jira?.ok ? 'Jira: ' + h.jira.user : 'Jira: disconnected';
        document.getElementById('gws-status').className = 'status-dot ' + (h.gws?.ok ? 'connected' : 'disconnected');
        document.getElementById('gws-label').textContent = h.gws?.ok ? 'GWS: ' + h.gws.user : 'GWS: disconnected';
      } catch {}
    }

    // Resolve missing parent epic names
    const parentCache = {};
    async function resolveMissingParents() {
      if (!DATA || !DATA.missingParents) return;
      for (const key of DATA.missingParents) {
        if (parentCache[key]) continue;
        try {
          const resp = await fetch('/api/jira/issue/' + key);
          const data = await resp.json();
          parentCache[key] = data;
          render(); // re-render with resolved name
        } catch {}
      }
    }

    // Initial load — use cache for instant render
    fetch('/api/data').then(r => r.json()).then(d => { DATA = d; render(); resolveMissingParents(); });
    checkHealth();
  </script>
</body>
</html>`;
}

// Track known action item hashes to detect new ones
let knownActionItemHashes = null;

function notifyNewActionItems(data) {
  if (!IS_MACOS || process.env.TRIAGE_NOTIFICATIONS === "false") return;
  if (!data.newItems || !data.newItems.length) {
    knownActionItemHashes = new Set();
    return;
  }
  const currentHashes = new Set(data.newItems.map(i => i.hash));
  if (knownActionItemHashes === null) {
    // First run — just record, don't notify
    knownActionItemHashes = currentHashes;
    return;
  }
  const brandNew = data.newItems.filter(i => !knownActionItemHashes.has(i.hash));
  if (brandNew.length) {
    const title = `${brandNew.length} new action item${brandNew.length > 1 ? 's' : ''}`;
    const body = brandNew.map(i => i.text).join('\n').slice(0, 200);
    const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)} sound name "Glass"`;
    execFile("osascript", ["-e", script], () => {});
  }
  knownActionItemHashes = currentHashes;
}

server.listen(PORT, () => {
  console.log(`Jirassic: http://localhost:${PORT}`);

  // Auto-refresh every 60 seconds
  setInterval(async () => {
    try {
      const data = await fetchAllData();
      notifyNewActionItems(data);
      broadcast({ type: "refresh", data });
    } catch (e) {
      console.error("Auto-refresh error:", e.message);
    }
  }, 60000);
});
