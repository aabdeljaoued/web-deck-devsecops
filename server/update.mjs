// Mise à jour en un clic (Réglages › Serveur) : compare la version locale avec GitHub (git fetch), puis
// git pull --ff-only, dépendances installées si package.json a changé, et redémarrage par l'appelant.
// Refuse si des fichiers suivis par Git ont été modifiés sur la machine (rien n'est écrasé).
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const isWindows = process.platform === "win32";

/** Exécute une commande dans le dossier du deck ; erreur = première ligne utile du message. */
function exec(cmd, args, cwd, timeout = 60000) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { cwd, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out, stderr) => {
            if (err) reject(new Error(String(stderr || err.message).trim().split("\n").filter(Boolean).pop() ?? "échec"));
            else resolve(String(out).trim());
        });
    });
}

export class Updater {
    constructor(root) {
        this.root = root;
        this.state = { version: null, date: null, behind: 0, dirty: [], checked: null, error: null };
    }

    git(args, timeout) {
        return exec("git", args, this.root, timeout);
    }

    /** Version installée (commit court et date), sans accès réseau. */
    async local() {
        if (!existsSync(path.join(this.root, ".git"))) throw new Error("ce dossier n'est pas un clone Git : mise à jour impossible ici (récupère la nouvelle version à la main)");
        this.state.version = await this.git(["rev-parse", "--short", "HEAD"]);
        this.state.date = await this.git(["log", "-1", "--format=%cI"]);
        // Fichiers suivis modifiés sur cette machine (les fichiers locaux hors Git ne comptent pas)
        const status = await this.git(["status", "--porcelain", "--untracked-files=no"]);
        // Lignes « XY chemin » (la première a pu perdre son espace initial) : on retire le code d'état
        this.state.dirty = status ? status.split("\n").map((l) => l.replace(/^\s*\S+\s+/, "").trim()).filter(Boolean) : [];
    }

    /** Compare avec GitHub : nombre de commits à récupérer. */
    async check() {
        try {
            await this.local();
            await this.git(["fetch", "--quiet", "origin"], 60000);
            this.state.behind = Number(await this.git(["rev-list", "--count", "HEAD..@{u}"])) || 0;
            this.state.error = null;
        } catch (err) {
            this.state.error = err.message;
        }
        this.state.checked = new Date().toISOString();
        return this.view();
    }

    view() {
        return { ...this.state, dirty: [...this.state.dirty] };
    }

    /** Récupère la nouvelle version ; dépendances installées si besoin. L'appelant redémarre ensuite. */
    async apply() {
        await this.check();
        if (this.state.error) throw new Error(`vérification impossible : ${this.state.error}`);
        if (this.state.dirty.length) throw new Error(`fichiers modifiés sur cette machine : ${this.state.dirty.join(", ")} (à valider ou annuler avant la mise à jour)`);
        if (!this.state.behind) throw new Error("déjà à jour");
        await this.git(["pull", "--ff-only", "--quiet"], 120000);
        // Même logique que les lanceurs : needs-install.mjs sort avec 0 si une installation est nécessaire
        const needsInstall = await exec(process.execPath, [path.join("server", "needs-install.mjs")], this.root).then(() => true, () => false);
        if (needsInstall) {
            if (isWindows) await exec("cmd.exe", ["/d", "/c", "npm", "install", "--omit=dev"], this.root, 600000);
            else await exec("npm", ["install", "--omit=dev"], this.root, 600000);
            await exec(process.execPath, [path.join("server", "needs-install.mjs"), "--done"], this.root);
        }
        await this.local();
        this.state.behind = 0;
        return this.view();
    }
}
