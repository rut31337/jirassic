# daily-automation-tools

Personal automation scripts for daily workflows.

## my-action-items

After a Google Meet call, Gemini automatically emails meeting notes to participants, including a "Suggested next steps" section with action items. This script pulls those emails from your Gmail and extracts just the action items assigned to you.

### Prerequisites

- Python 3
- [Google Workspace CLI (gws)](https://github.com/googleworkspace/cli) — installed and authenticated with Gmail access

### Setup

1. Set your name in your shell profile (`~/.zshrc` or `~/.bashrc`):

```bash
export GWS_NAME="Your Full Name"
```

2. Symlink or copy the script somewhere on your PATH:

```bash
ln -s $(pwd)/my-action-items ~/bin/my-action-items
```

3. Make it executable:

```bash
chmod +x my-action-items
```

### Usage

```bash
# Action items from the last 7 days (default)
my-action-items

# Action items from the last 14 days
my-action-items 14
```
