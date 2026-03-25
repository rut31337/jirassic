# daily-automation-tools

Personal automation scripts for daily workflows — track action items from Google Meet notes and reconcile with Jira tickets.

## Scripts

### my-action-items

After a Google Meet call, Gemini automatically emails meeting notes to participants, including a "Suggested next steps" section with action items. This script pulls those emails from your Gmail and extracts just the action items assigned to you.

### my-jira-tickets

Lists your open Jira tickets, grouped by epic. Useful for seeing your full workload at a glance.

### my-daily-triage

Combines action items and Jira tickets into a daily triage workflow. Tracks which items you've already reviewed so you only see new ones. Includes an interactive mode to mark items as done, skipped, or linked to a Jira ticket.

Features:
- macOS notifications (`--notify`)
- Static HTML dashboard (`--html`)
- Shell/Claude welcome message (`--welcome`)
- Interactive triage prompts

## Prerequisites

- Python 3
- [Google Workspace CLI (gws)](https://github.com/googleworkspace/cli) — installed and authenticated with Gmail access

## Setup

### 1. Set your name

Add to your `~/.zshrc` (or `~/.bashrc`):

```bash
export GWS_NAME="Your Full Name"
```

Your name should match how Gemini refers to you in meeting notes.

### 2. Create a Jira API token

1. Go to: https://id.atlassian.com/manage-profile/security/api-tokens
2. Click **Create API token**
3. Label it (e.g., `daily-triage`)
4. Copy the token

Add to your `~/.env` (or wherever you store secrets):

```bash
export JIRA_EMAIL="you@example.com"
export JIRA_API_TOKEN="your-token-here"
```

Make sure `~/.env` is sourced from your shell profile:

```bash
# In ~/.zshrc or ~/.bashrc
source ~/.env
```

**Note:** Atlassian API tokens do not expire by default. Check your org's policy and manage tokens at https://id.atlassian.com/manage-profile/security/api-tokens.

### 3. Install the scripts

**Option A: Quick install**

```bash
mkdir -p ~/bin
for script in my-action-items my-jira-tickets my-daily-triage; do
  curl -o ~/bin/$script https://raw.githubusercontent.com/rut31337/daily-automation-tools/main/$script
  chmod +x ~/bin/$script
done
```

**Option B: Clone the repo**

```bash
git clone https://github.com/rut31337/daily-automation-tools.git ~/daily-automation-tools
mkdir -p ~/bin
for script in my-action-items my-jira-tickets my-daily-triage; do
  ln -s ~/daily-automation-tools/$script ~/bin/$script
done
```

Make sure `~/bin` is in your PATH:

```bash
export PATH="$HOME/bin:$PATH"
```

## Usage

```bash
# Show your action items from the last 7 days
my-action-items

# Show your open Jira tickets
my-jira-tickets
my-jira-tickets --project MYPROJ

# Full daily triage — interactive
my-daily-triage

# Daily triage with all the bells and whistles
my-daily-triage --notify --html --project MYPROJ

# One-liner for shell welcome
my-daily-triage --welcome --no-interactive
```

## Optional: Shell welcome

Add to your `~/.zshrc` to see your triage summary when you open a terminal:

```bash
my-daily-triage --welcome --no-interactive 2>/dev/null
```

## Optional: macOS notification (cron)

Run daily at 9am:

```bash
crontab -e
# Add:
0 9 * * * source ~/.env && source ~/.zshrc && ~/bin/my-daily-triage --notify --html --no-interactive --project MYPROJ
```

## Dashboard

When you run `my-daily-triage --html`, a static HTML dashboard is generated at:

```
~/.config/daily-triage/dashboard.html
```

Open it in your browser: `open ~/.config/daily-triage/dashboard.html`
