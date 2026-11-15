# Troubleshooting

[← Contents](README.md)

Always start with **Settings › Server › Diagnostics**: each line says what works or not
(see [Diagnostics](10-reglages-et-tracabilite.md#diagnostics)).

| Problem | Solution |
|---|---|
| **Connected over ssh, but no frame and VM keys greyed out** | **Settings › Server › Diagnostics** while the terminal is connected, line **Connected terminals**: "monitoring STOPPED" (the monitoring PowerShell was killed, by an antivirus for example; it restarts by itself and the error is shown), or "NOT detected" with the ssh lineage and the reason ("pid … (absent)": ssh started from Git Bash, attached through the Git Bash lineage if Git's `ps.exe` is present). Send that line for analysis. |
| **"Access denied"** (browser or installed app) | The browser does not have the token, or no longer: first start, token renewed, cookies cleared. The page shows the command to run once (Terminal on Mac, PowerShell on Windows) to reopen the deck with its full address; after that the app opens directly. |
| **The deck stops by itself** | Started with `start.command` / `start.cmd`, closing its window stops it: install the service (see [Getting started](01-prise-en-main.md)). |
| **A `?token=…` address leaked** | Settings › Server › **Renew the token**: the old one no longer works anywhere. |
| **A tab shows the old version** | It reloads by itself when it reconnects; otherwise `⌘R`. |
| **A tool is "not found"** although it works in a terminal | Give its full path in `paths.<machine>.json`. |
| **An indicator shows "error"** | Run the same command in the terminal (`kubectl config current-context`, `git status`, `docker ps`) to see the message. |
| **Certificate "unreachable"** | The computer cannot reach the server (network, VPN); behind a proxy, set `HTTPS_PROXY` then restart the deck (see [Missions and certificates](08-missions-et-certificats.md#corporate-computer-and-proxy)). |
| **Update fails** | Diagnostics › Git access; behind a proxy: `git config --global http.proxy <proxy url>`. Also refused if tracked files were changed on the machine. |
| **No key in connect -i** | The window shows the folder searched; a PuTTY key (`.ppk`) must be converted (PuTTYgen, *Export OpenSSH key*). |
| **`{secret:…}` refused** | Vault locked, inexact or duplicate name, `cmd` terminal, or broadcast on: the message says which. |
| **Port 7777 is taken** | Change `port` in `config.jsonc`. |

## Checking on Windows

1. **Diagnostics**: clipboard, ssh / wsl detection, tools (Scoop), network and proxy.
2. **Service**: `service\installer.cmd`, close every window, the deck must still answer; Settings › Server shows
   "Running as a Windows service".
3. **Ansible**: greyed out, then enabled after an `ssh` to a Linux machine in the terminal.
4. **Vault › Copy**: paste elsewhere, then after 30 s the clipboard is empty.
