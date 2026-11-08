// Verrouillage de la session (écran verrouillé) : le coffre se verrouille aussitôt.
// macOS : "CGSSessionScreenIsLocked"=Yes dans `ioreg -n Root -d1` (lu toutes les 5 s).
// Windows : écran de verrouillage = processus LogonUI.exe, vu dans la liste des processus déjà lue
// par la détection ssh / wsl (server/remote.mjs, événement "procs").
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";

import { platform } from "./platform.mjs";

/** macOS : la sortie de ioreg indique-t-elle une session verrouillée ? */
export const macLocked = (ioreg) => /"CGSSessionScreenIsLocked"\s*=\s*Yes/.test(String(ioreg));

/** Windows : l'écran de verrouillage (LogonUI) est-il affiché ? (noms déjà normalisés par remote.mjs) */
export const windowsLocked = (procs) => procs.some((p) => p.name === "logonui");

/** Événement "change" (locked: boolean) à chaque passage verrouillé / déverrouillé. */
export class ScreenLock extends EventEmitter {
    constructor(remote) {
        super();
        this.remote = remote;
        this.locked = false;
        this.timer = null;
    }

    start() {
        if (platform === "mac") {
            this.timer = setInterval(() => {
                execFile("ioreg", ["-n", "Root", "-d1"], { maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
                    if (!err) this.set(macLocked(out));
                });
            }, 5000);
            this.timer.unref();
        } else if (platform === "windows") {
            this.remote.on("procs", (procs) => this.set(windowsLocked(procs)));
        }
    }

    stop() {
        clearInterval(this.timer);
    }

    set(locked) {
        if (locked === this.locked) return;
        this.locked = locked;
        this.emit("change", locked);
    }
}
