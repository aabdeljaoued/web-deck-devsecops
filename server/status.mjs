// Voyants : contexte kubectl, branche Git, conteneurs. Interrogés seulement quand une page est ouverte.
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** Exécute un programme et renvoie sa sortie standard (sans fenêtre console sous Windows). */
function run(file, args, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        execFile(file, args, { timeout: timeoutMs, windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) => {
            if (err) reject(new Error((stderr || err.message).trim()));
            else resolve(stdout);
        });
    });
}

/**
 * Chaque voyant publie un état { bg, title, lines, footer? } via l'événement "update" (id, état).
 */
export class StatusHub extends EventEmitter {
    constructor(ctx) {
        super();
        this.ctx = ctx;
        this.states = {};
        this.timers = [];
        this.kubeMtimes = "";
        this.repo = null;
    }

    /** Démarre les interrogations (premier client connecté). */
    start() {
        if (this.timers.length) return;
        this.refreshAll();
        this.timers = [
            setInterval(() => this.checkKubeconfig(), 2000),
            setInterval(() => this.refreshGit(), 5000),
            setInterval(() => this.refreshContainers(), 10000)
        ];
    }

    /** Arrête les interrogations (plus aucun client). */
    stop() {
        this.timers.forEach(clearInterval);
        this.timers = [];
    }

    refreshAll() {
        return Promise.all([this.refreshKube(), this.refreshGit(), this.refreshContainers()]);
    }

    /** Appui sur un voyant : rafraîchir, ou dépôt suivant pour Git. */
    async press(id) {
        if (id === "kube") await this.refreshKube();
        if (id === "containers") await this.refreshContainers();
        if (id === "git") {
            const repos = this.findRepos();
            if (repos.length) this.repo = repos[(repos.indexOf(this.repo) + 1) % repos.length];
            await this.refreshGit();
        }
    }

    publish(id, state) {
        if (JSON.stringify(this.states[id]) === JSON.stringify(state)) return;
        this.states[id] = state;
        this.emit("update", id, state);
    }

    // ---------- kubectl ----------

    /** Relance l'affichage si un des fichiers kubeconfig a été modifié. */
    async checkKubeconfig() {
        const files = (process.env.KUBECONFIG ?? path.join(homedir(), ".kube", "config")).split(path.delimiter).filter(Boolean);
        const mtimes = (await Promise.all(files.map((f) => stat(f).then((s) => s.mtimeMs, () => 0)))).join(",");
        if (mtimes !== this.kubeMtimes) {
            this.kubeMtimes = mtimes;
            await this.refreshKube();
        }
    }

    async refreshKube() {
        const kubectl = this.ctx.apps.kubectl;
        if (!kubectl) return this.publish("kube", { bg: "#455A64", title: "K8S", lines: ["kubectl", "introuvable"] });
        try {
            const out = await run(kubectl, ["config", "view", "--minify", "-o", "jsonpath={.current-context}|{..namespace}"]);
            const [context = "", namespace = ""] = out.trim().split("|");
            if (!context) return this.publish("kube", { bg: "#455A64", title: "K8S", lines: ["aucun", "contexte"] });
            const isProd = new RegExp(this.ctx.cfg.prodPattern || "prod", "i").test(`${context} ${namespace}`);
            this.publish("kube", {
                bg: isProd ? "#C62828" : "#326CE5",
                title: isProd ? "⚠ PROD" : "K8S",
                lines: contextLines(context),
                footer: `ns: ${namespace || "default"}`
            });
        } catch {
            this.publish("kube", { bg: "#455A64", title: "K8S", lines: ["kubectl", "erreur"] });
        }
    }

    /** Contextes et namespaces disponibles, pour le sélecteur du voyant K8s. */
    async listKube() {
        const kubectl = this.ctx.apps.kubectl;
        if (!kubectl) throw new Error("kubectl introuvable");
        const contexts = (await run(kubectl, ["config", "get-contexts", "-o", "name"])).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        const current = (await run(kubectl, ["config", "current-context"]).catch(() => "")).trim();
        const namespace = (await run(kubectl, ["config", "view", "--minify", "-o", "jsonpath={..namespace}"]).catch(() => "")).trim() || "default";
        // La liste des namespaces demande l'accès au cluster : vide si injoignable ou interdit
        let namespaces = [];
        let nsError = null;
        try {
            namespaces = (await run(kubectl, ["get", "namespaces", "-o", "jsonpath={.items[*].metadata.name}", "--request-timeout=5s"], 8000)).split(/\s+/).filter(Boolean);
        } catch (err) {
            nsError = err.message.split("\n")[0].slice(0, 160);
        }
        const prod = new RegExp(this.ctx.cfg.prodPattern || "prod", "i");
        return {
            contexts: contexts.map((name) => ({ name, prod: prod.test(name) })),
            current,
            namespaces: namespaces.map((name) => ({ name, prod: prod.test(name) })),
            namespace,
            nsError
        };
    }

    /** Change de contexte ou de namespace (valeurs vérifiées : arguments passés sans shell). */
    async useKube({ context, namespace }) {
        const kubectl = this.ctx.apps.kubectl;
        if (!kubectl) throw new Error("kubectl introuvable");
        if (context != null) {
            const contexts = (await run(kubectl, ["config", "get-contexts", "-o", "name"])).split(/\r?\n/).map((s) => s.trim());
            if (!contexts.includes(String(context))) throw new Error(`contexte inconnu : ${context}`);
            await run(kubectl, ["config", "use-context", String(context)]);
        }
        if (namespace != null) {
            if (!/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(String(namespace))) throw new Error(`namespace invalide : ${namespace}`);
            await run(kubectl, ["config", "set-context", "--current", `--namespace=${namespace}`]);
        }
        await this.refreshKube();
    }

    // ---------- Git ----------

    /** Dépôts Git trouvés dans les dossiers racines (la racine elle-même et ses sous-dossiers directs). */
    findRepos() {
        const repos = [];
        for (const root of this.ctx.gitRoots) {
            if (!existsSync(root)) continue;
            if (existsSync(path.join(root, ".git"))) repos.push(root);
            for (const entry of readdirSync(root, { withFileTypes: true })) {
                const dir = path.join(root, entry.name);
                if (entry.isDirectory() && existsSync(path.join(dir, ".git"))) repos.push(dir);
            }
        }
        return repos;
    }

    /** Dépôts connus et dépôt affiché, pour le sélecteur du voyant Git. */
    listRepos() {
        return { repos: this.findRepos().map((p) => ({ path: p, name: path.basename(p) })), current: this.repo ?? null };
    }

    async selectRepo(repo) {
        if (!this.findRepos().includes(repo)) throw new Error("dépôt inconnu");
        this.repo = repo;
        await this.refreshGit();
    }

    async refreshGit() {
        const git = this.ctx.apps.git;
        const repos = this.findRepos();
        const repo = repos.includes(this.repo) ? this.repo : repos[0];
        this.repo = repo;
        if (!git) return this.publish("git", { bg: "#455A64", title: "GIT", lines: ["git", "introuvable"] });
        if (!repo) return this.publish("git", { bg: "#455A64", title: "GIT", lines: ["aucun", "dépôt"] });
        try {
            const s = parseStatus(await run(git, ["-C", repo, "status", "--porcelain=v2", "--branch"]));
            const sync = [s.ahead ? `↑${s.ahead}` : "", s.behind ? `↓${s.behind}` : ""].filter(Boolean).join(" ");
            const changes = s.changes ? `${s.changes} modif.` : "propre";
            this.publish("git", {
                bg: s.changes ? "#E65100" : "#2E7D32",
                title: path.basename(repo),
                lines: [s.branch],
                footer: sync ? `${changes} ${sync}` : changes,
                repo
            });
        } catch {
            this.publish("git", { bg: "#455A64", title: path.basename(repo), lines: ["git", "erreur"] });
        }
    }

    // ---------- Conteneurs ----------

    async refreshContainers() {
        const [exe, ...baseArgs] = this.ctx.containerCli;
        const title = this.ctx.containerLabel;
        try {
            const out = await run(exe, [...baseArgs, "ps", "-a", "--format", "{{.State}}"], 15000);
            const states = out.split(/\r?\n/).map((s) => s.trim().toLowerCase()).filter(Boolean);
            const running = states.filter((s) => s === "running").length;
            this.publish("containers", { bg: running ? "#0898C8" : "#37474F", title, lines: [String(running)], footer: `actifs / ${states.length}` });
        } catch {
            this.publish("containers", { bg: "#455A64", title, lines: ["moteur", "arrêté ?"] });
        }
    }
}

/**
 * Met en forme le nom de contexte :
 *  - OpenShift "namespace/serveur:port/utilisateur" -> ["utilisateur", "@serveur"]
 *  - EKS "arn:aws:eks:region:compte:cluster/nom"     -> ["nom"]
 */
function contextLines(context) {
    const openshift = /^[^/]+\/([^/]+?)(?::\d+)?\/(.+)$/.exec(context);
    if (openshift) return [openshift[2], `@${openshift[1]}`];
    if (context.startsWith("arn:")) return [context.slice(context.lastIndexOf("/") + 1)];
    return [context];
}

/** Analyse la sortie de `git status --porcelain=v2 --branch`. */
function parseStatus(out) {
    let branch = "?";
    let ahead = 0;
    let behind = 0;
    let changes = 0;
    for (const line of out.split(/\r?\n/)) {
        if (line.startsWith("# branch.head ")) {
            const head = line.slice("# branch.head ".length);
            branch = head === "(detached)" ? "détachée" : head;
        } else if (line.startsWith("# branch.ab ")) {
            const m = /\+(\d+) -(\d+)/.exec(line);
            if (m) [ahead, behind] = [Number(m[1]), Number(m[2])];
        } else if (line && !line.startsWith("#")) {
            changes++;
        }
    }
    return { branch, ahead, behind, changes };
}
