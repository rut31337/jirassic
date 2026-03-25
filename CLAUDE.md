# daily-automation-tools

Personal automation scripts for daily workflows — action item tracking from Gemini meeting notes, Jira ticket management, and daily triage.

## Scripts

### my-action-items
Extracts action items assigned to the user from Gemini meeting notes emails via the Google Workspace CLI (gws). Parses the "Suggested next steps" section from `gemini-notes@google.com` emails.

- Requires: `gws` CLI installed and authenticated, `GWS_NAME` env var
- Supports `--json` output for piping to other scripts
- Usage: `my-action-items [--json] [DAYS]`

### my-jira-tickets
Lists open Jira tickets assigned to the user via the Jira REST API. Groups tickets by epic.

- Requires: `JIRA_API_TOKEN` and `JIRA_EMAIL` env vars
- Uses the `/rest/api/3/search/jql` endpoint (not the deprecated `/search`)
- Supports `--json` output and `--project` filter
- Usage: `my-jira-tickets [--json] [--project PROJECT]`

### my-daily-triage
Orchestrator that combines action items and Jira tickets into a daily triage workflow. Tracks which action items have been triaged in a local state file.

- Calls `my-action-items --json` and `my-jira-tickets --json` as subprocesses
- State file: `~/.config/daily-triage/state.json` — tracks triaged items by content hash
- Interactive mode: prompts user to mark items as skip/done/jira
- Flags:
  - `--notify` — macOS notification
  - `--html` — generates dashboard at `~/.config/daily-triage/dashboard.html`
  - `--welcome` — one-liner summary for shell/Claude welcome
  - `--no-interactive` — skip triage prompts
  - `--days N` — lookback period (default: 7)
  - `--project PROJ` — Jira project filter

## Environment Variables

All secrets are in `~/.env` (sourced from `~/.zshrc`):

- `GWS_NAME` — user's full name as Gemini refers to them (in `~/.zshrc`)
- `JIRA_API_TOKEN` — Jira personal API token (in `~/.env`)
- `JIRA_EMAIL` — Jira account email (in `~/.env`)
- `JIRA_SITE` — Jira instance (default: `redhat.atlassian.net`)

## Important Notes

- This is a public repo — never commit secrets, tokens, or internal URLs
- The Jira script uses basic auth with API tokens, not OAuth
- Action items are matched by content hash — if Gemini rephrases the same item in a different meeting, it will appear as new
- The state file only tracks items the user has explicitly triaged
