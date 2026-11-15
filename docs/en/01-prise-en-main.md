# Getting started

[← Contents](README.md)

The deck is a small local Node.js server (port **7777**) that serves a page in your browser: a grid of keys at the
top, terminals below. It only answers your machine (`127.0.0.1`) and requires a secret **token**.

## Requirements

- **Node.js 20 or newer** (22 recommended).
- The tools you already use (kubectl, helm, docker, git, ssh…). A key whose tool is missing says so and offers the
  install command.

## Installing on macOS

```bash
git clone https://github.com/aabdeljaoued/web-deck-devsecops.git
cd web-deck-devsecops
npm install
```

One-off start: double-click `start.command`.

**Automatic start (recommended)**: double-click `service/installer.command`. The deck becomes a service of your
session (LaunchAgent): it starts with the session and restarts by itself if it stops. Log:
`~/Library/Logs/web-deck-devsecops.log`. To remove it: `service/desinstaller.command`.

## Installing on Windows (without admin rights)

1. Install Node.js (the "portable" version or with Scoop, without admin rights).
2. Get the repository, then in the folder: `npm install`.
3. One-off start: `start.cmd`.
4. **Automatic start**: `service\installer.cmd`, which places a launcher in your session's Startup folder; the deck
   restarts if it stops.

On a corporate computer behind a proxy, set `HTTPS_PROXY` for your user (see
[Missions and certificates](08-missions-et-certificats.md#corporate-computer-and-proxy)).

## Installing the deck as an app (optional)

Besides the browser tab, the deck can be installed as an **app**: its own window (no address bar or tabs), an icon in
the **taskbar** and **Start menu** (Windows), or the **Dock** and Launchpad (macOS).

- **Settings › Server › Install the app**, or in Edge / Chrome: menu **⋯ › Apps › Install this site as an app**.
- It is the **same deck**, on the same local server: the service must be running (see above). If the server does not
  answer, the window explains it instead of showing an error page.
- **No admin rights**, no `.exe` to sign: nothing to get approved on a corporate computer.
- The browser **stays usable** alongside; as with two tabs, only one drives the terminals at a time ("Use here").
- To uninstall it: right-click the icon › Uninstall (or from `edge://apps` / `chrome://apps`).

## First start

- The page opens by itself; the address contains the token (`?token=…`), then kept in a cookie (400 days, extended at
  each opening): the next times, `http://127.0.0.1:7777/` and the installed app are enough.
- Only one tab drives the terminals: if you open another one, the previous one offers **"Use here"**.
- After an update, open tabs **reload by themselves** when they reconnect.
- **Language**: Settings › Appearance › **Language / Langue** switches the interface to English (or back to French).

## Where is my data?

Everything stays in the deck's folder, **outside Git**: favorites (`favoris.json`), encrypted vault (`vault.enc`),
settings and missions (`settings.json`), My actions (`actions.json`), log (`.deck-journal.jsonl`), recordings
(`.deck-recordings/`), backups (`.deck-backups/`). To move from one computer to another, see
[Settings › Full configuration](10-reglages-et-tracabilite.md#full-configuration-and-update).
