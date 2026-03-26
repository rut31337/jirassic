# daily-automation-tools (Jirassic)

Personal automation scripts for daily workflows — action item tracking from Gemini meeting notes, Jira ticket management, and daily triage with a live web dashboard.

## Architecture

```
Browser (localhost:31337)
    ↕ WebSocket (live updates, auto-refresh every 60s)
jirassic-server.js (Node.js)
    → my-action-items --json (Python, calls gws CLI for Gmail)
    → my-jira-tickets --json (Python, calls Jira REST API)
    → ~/.config/daily-triage/state.json (triage state)
    → ~/.config/daily-triage/cache.json (data cache for fast rebuilds)
```

## Files

### jirassic-server.js
Node.js server that powers the Jirassic web dashboard. Contains all HTML/CSS/JS inline (no separate frontend files). Key features:
- WebSocket for live updates
- Auto-refresh every 60 seconds
- REST API for triage actions, Jira CRUD, health checks, config management
- Dashboard page (`/`) and config page (`/config`)
- Light/dark theme toggle (persisted in localStorage)
- Collapsible epics with story point tracking
- Inline editing of ticket status, priority, summary, story points
- Triage modal with create/link Jira ticket workflow

### jirassic
Bash script to start/stop/restart the server. Usage: `jirassic start|stop|restart|status|open`
- Sources `~/.env` for secrets
- Runs with `node --watch` so code changes auto-restart the server
- PID file at `~/.config/daily-triage/server.pid`
- Logs at `~/.config/daily-triage/server.log`

### my-action-items
Python script that extracts action items from Gemini meeting notes emails via gws CLI.
- Requires: `gws` CLI installed and authenticated, `GWS_NAME` env var
- `GWS_NAME` supports colon-separated list of name variants (e.g., `Full Name:First:username:Nick `)
- Trailing space in a name prevents false matches (e.g., "Pat " won't match "Pattern")
- Supports `--json` output for piping to other scripts
- Sorts results by date/time, newest first

### my-jira-tickets
Python script that lists open Jira tickets via REST API. Groups by epic with sprint detection.
- Requires: `JIRA_API_TOKEN` and `JIRA_EMAIL` env vars
- Uses `/rest/api/3/search/jql` endpoint
- Returns sprint, last_sprint, story_points, parent epic info
- Supports `--json` output and `--project` filter

### my-daily-triage
Python CLI orchestrator (kept for terminal/cron usage alongside the web dashboard).
- Calls `my-action-items --json` and `my-jira-tickets --json` as subprocesses
- State file: `~/.config/daily-triage/state.json`
- Flags: `--notify`, `--welcome`, `--no-interactive`, `--days N`, `--project PROJ`

## Environment Variables

All in `~/.env` (sourced from `~/.zshrc`):

- `GWS_NAME` — colon-separated name variants for matching in meeting notes
- `JIRA_API_TOKEN` — Jira personal API token
- `JIRA_EMAIL` — Jira account email
- `JIRA_SITE` — Jira instance hostname (default: `redhat.atlassian.net`)
- `TRIAGE_PROJECT` — default Jira project filter (default: `GPTEINFRA`)
- `TRIAGE_DAYS` — default lookback days (default: `7`)

Config page at `/config` can manage Jira settings and GWS name variants.

## Jira Integration Details

- Assignee ID is resolved dynamically via `/rest/api/3/myself` (cached after first call)
- Story points field: `customfield_10028`
- Sprint field: `customfield_10020`
- Project default: `GPTEINFRA`
- Status changes use transitions API, not direct field updates

## Important Notes

- Public repo — never commit secrets, tokens, or internal URLs
- Action items matched by SHA-256 content hash (first 16 chars)
- Triage state persists across server restarts via state.json
- Cache stores raw API responses for instant triage/untriage without re-fetching
- @redhat.com users see additional warnings about token expiry and GWS setup docs
