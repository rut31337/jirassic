# Jirassic — Daily Triage Dashboard

Track action items from Google Meet notes and reconcile with Jira tickets. Includes a live web dashboard with interactive triage, inline ticket editing, and real-time updates.

![Dashboard](https://img.shields.io/badge/port-31337-blue) ![Node.js](https://img.shields.io/badge/node.js-18+-green) ![Python](https://img.shields.io/badge/python-3-blue)

## What it does

1. **Pulls action items** from Gemini meeting notes in your Gmail
2. **Pulls Jira tickets** assigned to you, grouped by epic and sprint
3. **Lets you triage** — skip, mark done, link to existing ticket, or create new Jira tickets
4. **Live dashboard** at `localhost:31337` with WebSocket updates, auto-refresh, and inline editing

## Quick Start

### Prerequisites

- Python 3
- Node.js 18+
- [Google Workspace CLI (gws)](https://github.com/googleworkspace/cli) — installed and authenticated with Gmail access

### 1. Clone and install

```bash
git clone https://github.com/rut31337/daily-automation-tools.git ~/daily-automation-tools
cd ~/daily-automation-tools
npm install
```

### 2. Set your name

Add to your `~/.env`:

```bash
export GWS_NAME="Your Full Name"
# Multiple name variants (colon-separated):
export GWS_NAME="Full Name:FirstName:username:Nick "
# Trailing space prevents false matches (e.g., "Pat " won't match "Pattern")
```

Make sure `~/.env` is sourced from your shell profile:

```bash
# In ~/.zshrc or ~/.bashrc
source ~/.env
```

### 3. Create a Jira API token

1. Go to: https://id.atlassian.com/manage-profile/security/api-tokens
2. Click **Create API token**
3. Add to your `~/.env`:

```bash
export JIRA_EMAIL="you@example.com"
export JIRA_API_TOKEN="your-token-here"
```

**Note:** Atlassian API tokens do not expire by default. Some organizations enforce rotation — check your org's policy.

### 4. Symlink the scripts

```bash
mkdir -p ~/bin
for script in my-action-items my-jira-tickets my-daily-triage jirassic; do
  ln -sf ~/daily-automation-tools/$script ~/bin/$script
done
```

### 5. Start the dashboard

```bash
jirassic start
# or: jirassic open  (starts and opens browser)
```

Dashboard: http://localhost:31337

## Scripts

| Script | Description |
|--------|-------------|
| `jirassic` | Start/stop/restart the dashboard server |
| `my-action-items` | Extract action items from Gemini meeting notes |
| `my-jira-tickets` | List open Jira tickets grouped by epic |
| `my-daily-triage` | CLI triage tool (terminal alternative to dashboard) |

## Dashboard Features

- **Action item triage** — Skip, Done, Create Jira Ticket, or Link to existing ticket
- **Jira ticket management** — view by sprint (current, last, backlog, all)
- **Inline editing** — click to change status, priority, summary, or story points
- **Epic grouping** — collapsible epics with child count and story point totals
- **Missing story points** — ⚠️ warnings on tasks, count badge on epics
- **Create tickets** — under epics or standalone, with assign and story point options
- **Live updates** — WebSocket + auto-refresh every 60 seconds
- **Light/dark theme** — toggle in top right, persisted
- **Config page** — manage Jira credentials and GWS name variants at `/config`

## Managing the Server

```bash
jirassic start     # Start the dashboard server
jirassic stop      # Stop the server
jirassic restart   # Restart the server
jirassic status    # Check if running
jirassic open      # Start (if needed) and open in browser
```

The server runs with `--watch` mode — code changes to `jirassic-server.js` auto-restart it.

## CLI Usage

```bash
# Action items from the last 7 days
my-action-items

# Action items as JSON
my-action-items --json 14

# Open Jira tickets
my-jira-tickets
my-jira-tickets --project MYPROJ

# Terminal triage
my-daily-triage
my-daily-triage --notify --project MYPROJ

# Shell welcome (add to ~/.zshrc)
my-daily-triage --welcome --no-interactive
```

## Configuration

Visit http://localhost:31337/config to manage:

- **Jira** — email, API token, site URL (saved to `~/.env`)
- **GWS** — name variants for meeting note matching
- **Connection status** — verify Jira and GWS connectivity

## Environment Variables

| Variable | Description | Location |
|----------|-------------|----------|
| `GWS_NAME` | Colon-separated name variants | `~/.env` |
| `JIRA_EMAIL` | Atlassian account email | `~/.env` |
| `JIRA_API_TOKEN` | Jira API token | `~/.env` |
| `JIRA_SITE` | Jira hostname (default: `redhat.atlassian.net`) | `~/.env` |
| `TRIAGE_PROJECT` | Default project filter (default: `GPTEINFRA`) | `~/.env` or env |
| `TRIAGE_DAYS` | Default lookback days (default: `7`) | `~/.env` or env |
