// Sessions de terminal (pseudo-terminal node-pty). Elles appartiennent au serveur : recharger la page
// ne coupe pas une commande en cours, la fin de la sortie est rejouée à la reconnexion.
import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import path from "node:path";
import pty from "node-pty";

import { isMac, isWindows } from "./platform.mjs";

const REPLAY_BYTES = 256 * 1024;   // sortie conservée par session pour la reconnexion

// macOS : le spawn-helper précompilé de node-pty est parfois installé sans droit d'exécution
if (isMac) {
    try {
        const root = path.dirname(createRequire(import.meta.url).resolve("node-pty/package.json"));
        const helper = path.join(root, "prebuilds", `darwin-${process.arch}`, "spawn-helper");
        if (existsSync(helper) && !(statSync(helper).mode & 0o111)) chmodSync(helper, 0o755);
    } catch { /* node-pty compilé localement : rien à corriger */ }
}

/**
 * Événements : "output" (sid, data), "exit" (sid, code).
 */
export class Terminals extends EventEmitter {
    constructor(ctx) {
        super();
        this.ctx = ctx;
        this.sessions = new Map();
        this.counter = 0;
        this.env = terminalEnv(ctx);
    }

    /** Ouvre un shell (index dans ctx.shells) ; renvoie la description de la session. */
    open(shellIndex = 0, cols = 100, rows = 30) {
        const shell = this.ctx.shells[shellIndex] ?? this.ctx.shells[0];
        if (!shell) throw new Error("aucun shell trouvé (voir \"shells\" dans paths.json)");
        const [exe, ...args] = shell.command;
        const proc = pty.spawn(exe, args, {
            name: "xterm-256color",
            cols: clamp(cols, 20, 500),
            rows: clamp(rows, 5, 200),
            cwd: this.ctx.workspace,
            env: this.env,
            useConpty: isWindows ? true : undefined
        });
        const sid = String(++this.counter);
        const session = { sid, name: shell.name, proc, buffer: "" };
        this.sessions.set(sid, session);

        proc.onData((data) => {
            session.buffer = (session.buffer + data).slice(-REPLAY_BYTES);
            this.emit("output", sid, data);
        });
        proc.onExit(({ exitCode }) => {
            this.sessions.delete(sid);
            this.emit("exit", sid, exitCode);
        });
        return this.describe(session);
    }

    describe(session) {
        return { sid: session.sid, name: session.name };
    }

    list() {
        return [...this.sessions.values()].map((s) => ({ ...this.describe(s), replay: s.buffer }));
    }

    write(sid, data) {
        this.sessions.get(sid)?.proc.write(data);
    }

    resize(sid, cols, rows) {
        try {
            this.sessions.get(sid)?.proc.resize(clamp(cols, 20, 500), clamp(rows, 5, 200));
        } catch { /* session en cours de fermeture */ }
    }

    close(sid) {
        this.sessions.get(sid)?.proc.kill();
    }

    closeAll() {
        for (const s of this.sessions.values()) s.proc.kill();
    }
}

const clamp = (n, min, max) => Math.min(max, Math.max(min, Math.floor(Number(n) || min)));

/** Environnement des shells : celui du serveur, plus le dossier de la CLI "code" si VS Code n'est pas dans le PATH. */
function terminalEnv(ctx) {
    const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" };
    const vscode = ctx.apps.vscode;
    if (vscode) {
        // Windows : ...\Microsoft VS Code\Code.exe -> ...\Microsoft VS Code\bin (code.cmd) ; macOS : déjà .../bin/code
        const bin = /^code(\.cmd)?$/i.test(path.basename(vscode)) ? path.dirname(vscode) : path.join(path.dirname(vscode), "bin");
        const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
        const dirs = (env[key] ?? "").split(path.delimiter);
        if (existsSync(bin) && !dirs.includes(bin)) env[key] = [...dirs, bin].join(path.delimiter);
    }
    return env;
}
