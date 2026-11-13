// Sessions de terminal (pseudo-terminal node-pty). Elles appartiennent au serveur : recharger la page
// ne coupe pas une commande en cours, la fin de la sortie est rejouée à la reconnexion.
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
 * stateFile : fichier où sont gardés shell, nom, dossier et ordre des terminaux, pour les rouvrir au redémarrage.
 */
export class Terminals extends EventEmitter {
    constructor(ctx, stateFile) {
        super();
        this.ctx = ctx;
        this.sessions = new Map();
        this.counter = 0;
        this.stateFile = stateFile;
        this.closing = false;
    }

    /**
     * Ouvre un shell (index dans ctx.shells) ; renvoie la description de la session.
     * cwd : dossier de départ, déjà vérifié par l'appelant (sinon le workspace).
     */
    open(shellIndex = 0, cols = 100, rows = 30, { cwd, title } = {}) {
        const shell = this.ctx.shells[shellIndex] ?? this.ctx.shells[0];
        if (!shell) throw new Error("aucun shell trouvé (voir \"shells\" dans paths.json)");
        // Dossier de départ : demandé, sinon celui de la mission active (s'il existe), sinon le workspace
        const dir = cwd && existsSync(cwd) ? cwd : this.workspaceOverride && existsSync(this.workspaceOverride) ? this.workspaceOverride : this.ctx.workspace;
        const [exe, ...args] = shell.command;
        const proc = pty.spawn(exe, args, {
            name: "xterm-256color",
            cols: clamp(cols, 20, 500),
            rows: clamp(rows, 5, 200),
            cwd: dir,
            // Recalculé à chaque terminal : suit le proxy choisi dans le deck (variables du serveur modifiées)
            env: terminalEnv(this.ctx),
            useConpty: isWindows ? true : undefined
        });
        const sid = String(++this.counter);
        const session = { sid, name: shell.name, kind: shell.kind, cwd: dir, title: title || null, proc, buffer: "" };
        this.sessions.set(sid, session);

        proc.onData((data) => {
            session.buffer = (session.buffer + data).slice(-REPLAY_BYTES);
            this.emit("output", sid, data);
        });
        proc.onExit(({ exitCode }) => {
            this.sessions.delete(sid);
            this.emit("exit", sid, exitCode);
            this.save();
        });
        this.save();
        return this.describe(session);
    }

    /** Enregistre shell, nom et dossier des terminaux ouverts, dans l'ordre (pas pendant l'arrêt du serveur). */
    save() {
        if (!this.stateFile || this.closing) return;
        const data = [...this.sessions.values()].map(({ name, title, cwd }) => ({ shell: name, title, cwd }));
        try { writeFileSync(this.stateFile, JSON.stringify(data, null, 2)); } catch { /* disque en lecture seule : tant pis */ }
    }

    /** Au démarrage : rouvre les terminaux de la dernière fois (les commandes en cours, elles, sont perdues). */
    restore() {
        if (!this.stateFile || !existsSync(this.stateFile)) return 0;
        let saved;
        try { saved = JSON.parse(readFileSync(this.stateFile, "utf8")); } catch { return 0; }
        if (!Array.isArray(saved)) return 0;
        let count = 0;
        for (const s of saved.slice(0, 12)) {
            const index = Math.max(0, this.ctx.shells.findIndex((sh) => sh.name === s?.shell));
            try {
                this.open(index, 100, 30, { cwd: typeof s?.cwd === "string" ? s.cwd : undefined, title: typeof s?.title === "string" ? s.title.slice(0, 40) : null });
                count++;
            } catch { /* shell disparu : ignoré */ }
        }
        return count;
    }

    describe(session) {
        return { sid: session.sid, name: session.name, kind: session.kind, title: session.title ?? null };
    }

    /** Nom choisi par l'utilisateur (vide = nom par défaut "shell n°"). Renvoie le nom retenu, ou undefined. */
    rename(sid, title) {
        const session = this.sessions.get(sid);
        if (!session) return undefined;
        const clean = String(title ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40);
        session.title = clean || null;
        this.save();
        return session.title;
    }

    /** Place la session avant une autre (before absent ou inconnu = à la fin). Renvoie le nouvel ordre. */
    move(sid, before) {
        const session = this.sessions.get(sid);
        if (!session || sid === before) return this.order();
        const entries = [...this.sessions].filter(([id]) => id !== sid);
        const at = entries.findIndex(([id]) => id === before);
        entries.splice(at < 0 ? entries.length : at, 0, [sid, session]);
        this.sessions = new Map(entries);
        this.save();
        return this.order();
    }

    order() {
        return [...this.sessions.keys()];
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

    /** Arrêt du serveur : les terminaux sont fermés sans effacer leur sauvegarde. */
    closeAll() {
        this.save();
        this.closing = true;
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
