# Security

[← Contents](README.md)

The deck gives a full shell and keeps secrets: access is locked down, and the data stays on your computer.

## Access to the deck

- The server only listens on `127.0.0.1`: no other machine can connect to it.
- A random **token** (`.deck-token`, outside Git) is required in the startup address, then exchanged for an
  `HttpOnly`, `SameSite=Strict` cookie, specific to the deck's port (another deck on the same machine cannot overwrite
  it) and kept 400 days (extended at each opening) so that the installed app opens directly. **Renew the token**
  (Settings › Server) invalidates it everywhere if it leaked.
- The `Host` header is checked (protection against DNS rebinding), as is the WebSockets' `Origin`: another page open
  in the browser cannot connect.
- The page refuses to be shown in an iframe and applies a strict Content-Security-Policy.
- "Run" keys only send their identifier: the server only runs the commands of its catalog.

## Secrets

- Vault encrypted with **AES-256-GCM**, key derived from the master password with **scrypt**; automatic lock
  (15 min, and when the computer's screen locks).
- **Copy** goes through the system clipboard, written by the server and **cleared after 30 s**: the value does not
  go through the page.
- **`{secret:name}`** in a command: read by the shell without echo; the value goes neither through the page, nor the
  screen, nor the history, nor the log, nor the recordings.
- Sensitive parameters (`password`, `token`, `secret`…) are never kept in the input history.

## Safeguards

- Production flagged everywhere (red border, indicator, banner); sensitive actions and switching context to
  production **confirmed by a second click**; **diff** offered before applying (see
  [Kubernetes and production](03-kubernetes-et-production.md)).
- **Screen sharing mode** for meetings (see [Settings](10-reglages-et-tracabilite.md#screen-sharing-mode)).

## Data outside Git

Favorites, vault, settings and missions, My actions, log, recordings, backups and signature are excluded from the
repository (`.gitignore`): a customer's information never ends up on GitHub.
