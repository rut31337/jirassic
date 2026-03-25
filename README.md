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

2. Install the script:

```bash
# Quick install
mkdir -p ~/bin
curl -o ~/bin/my-action-items https://raw.githubusercontent.com/rut31337/daily-automation-tools/main/my-action-items && chmod +x ~/bin/my-action-items
```

Make sure `~/bin` is in your PATH. Add this to your `~/.zshrc` if it isn't:

```bash
export PATH="$HOME/bin:$PATH"
```

### Usage

```bash
# Action items from the last 7 days (default)
my-action-items

# Action items from the last 14 days
my-action-items 14
```
