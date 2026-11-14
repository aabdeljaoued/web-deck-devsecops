// Connexions distantes dans les terminaux : un terminal est « distant » quand une session ssh (ou mosh, ou wsl)
// y a été lancée depuis un shell. Sert aux rubriques qui demandent un shell Linux / macOS (Ansible sous Windows) :
// leurs touches s'activent quand le terminal actif est connecté à une machine Linux ou macOS.
// Un ssh lancé par un autre programme (git push, scp, rsync…) ne compte pas : seul celui dont le parent est un shell.
import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";

import { platform } from "./platform.mjs";

const REMOTE = { ssh: "ssh", mosh: "ssh", "mosh-client": "ssh", wsl: "wsl" };
const SHELLS = new Set(["zsh", "bash", "sh", "dash", "fish", "ksh", "tcsh", "csh", "pwsh", "powershell", "cmd", "sudo", "login", "nu"]);
const INTERVAL_MS = 2500;

/** Mots d'une ligne de commande (guillemets simples ou doubles retirés). */
function words(cmdline) {
    return [...String(cmdline ?? "").matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

/** Options de ssh suivies d'une valeur (ssh -i clé, -p port, -l utilisateur, -o option…). */
const SSH_VALUE_OPTS = new Set("BbcDEeFIiJLlmOoPpQRSWw".split(""));

/**
 * Destination d'une commande ssh : « utilisateur@hôte » ou « hôte » (alias de ~/.ssh/config compris), ou null.
 * Seule la destination est gardée : ni la clé, ni les options, ni la commande distante.
 */
export function sshTarget(cmdline) {
    const argv = words(cmdline).slice(1);
    let user = null;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--") { const d = argv[i + 1]; return d ? withUser(d, user) : null; }
        if (a.startsWith("-") && a.length > 1) {
            // Options groupées (-tt, -Nv…) : la première option à valeur prend la suite du mot, ou le mot suivant
            for (let j = 1; j < a.length; j++) {
                if (!SSH_VALUE_OPTS.has(a[j])) continue;
                const value = a.slice(j + 1) || argv[++i];
                if (a[j] === "l") user = value;
                break;
            }
            continue;
        }
        return withUser(a, user);
    }
    return null;
}
function withUser(dest, user) {
    const m = /^ssh:\/\/(?:([^@/]+)@)?([^:/]+)/i.exec(dest);
    const target = m ? `${m[1] ? `${m[1]}@` : ""}${m[2]}` : dest;
    if (!/^[A-Za-z0-9_.@:%[\]-]{1,255}$/.test(target)) return null;
    return user && !target.includes("@") ? `${user}@${target}` : target;
}

/**
 * Destination ssh découpée : { user, host, via }. Bastion type CyberArk PSMP :
 * « compte@utilisateur_cible@hôte_cible@bastion » -> utilisateur_cible @ hôte_cible, via bastion.
 */
export function splitTarget(dest) {
    const parts = String(dest ?? "").split("@");
    if (parts.length >= 3) return { user: parts.at(-3), host: parts.at(-2), via: parts.at(-1) };
    if (parts.length === 2) return { user: parts[0], host: parts[1], via: null };
    return { user: null, host: parts[0], via: null };
}

/** Distribution d'une commande wsl (wsl -d Ubuntu) ; null = distribution par défaut. */
export function wslTarget(cmdline) {
    const argv = words(cmdline);
    const i = argv.findIndex((a) => a === "-d" || a === "--distribution");
    return i >= 0 && argv[i + 1] ? argv[i + 1].slice(0, 60) : null;
}

/**
 * Sortie de « ps » de Git Bash (MSYS) -> [{ pid, ppid, winpid, cmd }] (pid / ppid MSYS, winpid = processus Windows).
 * Lignes « [lettre d'état]  PID  PPID  PGID  WINPID  TTY  UID  STIME  COMMAND ».
 */
export function parseMsysPs(text) {
    return String(text).split(/\r?\n/).map((l) => /^\s*[A-Z]?\s*(\d+)\s+(\d+)\s+\d+\s+(\d+)\s+\S+\s+\d+\s+\S+\s+(.*)$/.exec(l))
        .filter(Boolean).map(([, pid, ppid, winpid, cmd]) => ({ pid: +pid, ppid: +ppid, winpid: +winpid, cmd: cmd.trim() }));
}

/** Nom de programme sans chemin ni .exe, en minuscules (« /usr/bin/ssh » ou « ssh.exe » -> « ssh »). */
const base = (name) => path.basename(String(name).trim().replace(/\\/g, "/")).toLowerCase().replace(/\.exe$/, "").replace(/^-/, "");

export class RemoteWatch extends EventEmitter {
    /** @param terminals server/terminal.mjs (sessions : sid -> { proc }) */
    constructor(terminals) {
        super();
        this.terminals = terminals;
        this.state = new Map();   // sid -> "ssh" | "wsl"
        this.pids = new Map();    // sid -> pid du ssh / wsl détecté
        this.cmds = new Map();    // pid -> ligne de commande (lue une fois par connexion)
        this.dest = new Map();    // sid -> destination (« admin@app-prod-01 », distribution wsl)
        // Git Bash (Windows) : le processus intermédiaire entre bash et ssh disparaît, le ssh n'a plus de parent
        // Windows visible ; sa filiation est retrouvée dans la table de processus MSYS (ps.exe de Git)
        this.msysOwner = new Map();   // pid Windows du ssh -> { sid, at } (sid null : pas rattaché, réessai plus tard)
        this.msysRun = null;          // commande ps de MSYS (tests : remplaçable)
        this.timer = null;
        this.ps = null;           // Windows : PowerShell qui liste les processus en boucle
    }

    start() {
        if (platform === "windows") return this.startWindows();
        this.timer = setInterval(() => this.pollUnix(), INTERVAL_MS);
        this.timer.unref();
    }

    stop() {
        this.stopped = true;
        clearInterval(this.timer);
        this.ps?.kill();
    }

    /** État envoyé aux pages : { sid: "ssh" | "wsl" } pour les terminaux distants. */
    view() {
        return Object.fromEntries(this.state);
    }

    /** Destinations connues : { sid: "admin@app-prod-01.client.fr" } (ssh), ou la distribution (wsl). */
    targets() {
        return Object.fromEntries(this.dest);
    }

    /** ps.exe de Git Bash (MSYS), à côté du bash.exe d'un shell configuré ; null si aucun. */
    msysPsPath() {
        if (this._msysPs !== undefined) return this._msysPs;
        for (const s of this.terminals.ctx?.shells ?? []) {
            const exe = String(s.command?.[0] ?? "");
            if (!/bash(\.exe)?$/i.test(exe)) continue;
            const dir = path.dirname(exe);
            for (const c of [path.join(dir, "ps.exe"), path.join(dir, "..", "usr", "bin", "ps.exe")]) {
                if (existsSync(c)) return (this._msysPs = c);
            }
        }
        return (this._msysPs = null);
    }

    /** Table de processus MSYS (texte de ps.exe), ou null si indisponible. */
    readMsys() {
        if (this.msysRun) return this.msysRun();
        const ps = this.msysPsPath();
        if (!ps) return Promise.resolve(null);
        return new Promise((resolve) => execFile(ps, ["-a"], { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 }, (err, out) => resolve(err && !out ? null : String(out))));
    }

    /**
     * Rattache des ssh « orphelins » (parent Windows disparu) à un terminal par la filiation MSYS : on remonte les
     * parents MSYS du ssh jusqu'à un processus Windows appartenant à un terminal (son bash).
     */
    async linkMsys(orphans, owner) {
        if (this.msysBusy) return;
        this.msysBusy = true;
        try {
            const rows = parseMsysPs(await this.readMsys() ?? "");
            const byWin = new Map(rows.map((r) => [r.winpid, r]));
            const byPid = new Map(rows.map((r) => [r.pid, r]));
            for (const pid of orphans) {
                let row = byWin.get(pid), sid = null;
                for (let i = 0; row && i < 20; i++) {
                    const parent = byPid.get(row.ppid);
                    if (!parent || parent === row) break;
                    if (owner.has(parent.winpid)) { sid = owner.get(parent.winpid); break; }
                    row = parent;
                }
                this.msysOwner.set(pid, { sid, at: Date.now() });
            }
        } finally {
            this.msysBusy = false;
        }
        if (this.lastProcs) this.update(this.lastProcs);
    }

    /** Destination d'un ssh / wsl à partir de sa ligne de commande. */
    targetOf(kind, cmdline) {
        return kind === "wsl" ? wslTarget(cmdline) : sshTarget(cmdline);
    }

    /** macOS / Linux : lignes de commande des seuls ssh / wsl détectés et pas encore lus (un ps ciblé). */
    readArgsUnix(pids) {
        execFile("ps", ["-o", "pid=,args=", "-p", pids.join(",")], { maxBuffer: 1024 * 1024 }, (err, out) => {
            if (err && !out) return;
            for (const line of String(out).split("\n")) {
                const m = /^\s*(\d+)\s+(.*)$/.exec(line);
                if (m) this.cmds.set(Number(m[1]), m[2]);
            }
            this.resolveTargets();
        });
    }

    /** Destinations recalculées ; « change » si l'une a changé (ou si force : type de connexion changé). */
    resolveTargets(force = false) {
        const next = new Map();
        for (const [sid, pid] of this.pids) {
            const cmd = this.cmds.get(pid);
            const t = cmd ? this.targetOf(this.state.get(sid), cmd) : null;
            if (t) next.set(sid, t);
        }
        const changed = next.size !== this.dest.size || [...next].some(([sid, t]) => this.dest.get(sid) !== t);
        this.dest = next;
        if (changed || force) this.emit("change", this.view());
    }

    pollUnix() {
        if (!this.terminals.sessions.size) return this.update([]);
        execFile("ps", ["-A", "-o", "pid=,ppid=,comm="], { maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
            if (err) return;
            this.update(String(out).split("\n").map((line) => /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)).filter(Boolean)
                .map(([, pid, ppid, name]) => ({ pid: +pid, ppid: +ppid, name: base(name) })));
        });
    }

    /** Relevé ponctuel des processus (diagnostic) : [{ pid, ppid, name }], ou une erreur. */
    snapshot() {
        const parse = (out, re) => String(out).split(/\r?\n/).map((l) => re.exec(l)).filter(Boolean)
            .map(([, pid, ppid, name]) => ({ pid: +pid, ppid: +ppid, name: base(name) }));
        return new Promise((resolve, reject) => {
            if (platform === "windows") {
                execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
                    'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }'],
                { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 20000 },
                (err, out) => (err ? reject(err) : resolve(parse(out, /^(\d+)\s+(\d+)\s+(.+)$/))));
            } else {
                execFile("ps", ["-A", "-o", "pid=,ppid=,comm="], { maxBuffer: 8 * 1024 * 1024 },
                    (err, out) => (err ? reject(err) : resolve(parse(out, /^\s*(\d+)\s+(\d+)\s+(.+)$/))));
            }
        });
    }

    /**
     * Explication de la détection (diagnostic) : pour chaque ssh / mosh / wsl du dernier relevé, sa lignée de parents
     * et pourquoi il est rattaché, ou non, à un terminal du deck.
     */
    explain() {
        const procs = this.lastProcs ?? [];
        const byPid = new Map(procs.map((p) => [p.pid, p]));
        const roots = new Map([...this.terminals.sessions].map(([sid, s]) => [s.proc?.pid, sid]));
        return procs.filter((p) => REMOTE[p.name]).map((p) => {
            const chain = [];
            let cur = p, sid = null;
            for (let i = 0; i < 12 && cur; i++) {
                if (roots.has(cur.ppid)) { sid = roots.get(cur.ppid); chain.push(`terminal ${sid}`); break; }
                const parent = byPid.get(cur.ppid);
                chain.push(parent ? parent.name : `pid ${cur.ppid} (absent)`);
                cur = parent;
            }
            const direct = byPid.get(p.ppid);
            const msys = this.msysOwner.get(p.pid);
            if (!sid && msys?.sid) { sid = msys.sid; chain.push(`terminal ${sid} (filiation Git Bash)`); }
            const shellParent = roots.has(p.ppid) || (direct && SHELLS.has(direct.name)) || Boolean(msys?.sid);
            return { pid: p.pid, name: p.name, chain, terminal: sid, detected: [...this.pids].some(([, pid]) => pid === p.pid),
                why: !sid ? (msys ? "hors des terminaux du deck (même par la filiation Git Bash)" : this.msysPsPath() || this.msysRun ? "filiation Git Bash en cours de lecture" : "hors des terminaux du deck") : !shellParent ? `parent « ${direct?.name ?? "?"} » : pas un shell connu` : "",
                dest: this.cmds.has(p.pid) ? this.targetOf(REMOTE[p.name], this.cmds.get(p.pid)) : null };
        });
    }

    /** Surveillance en cours (Windows : le PowerShell en tâche de fond tourne-t-il ?). */
    get watching() {
        return platform === "windows" ? Boolean(this.ps) : Boolean(this.timer);
    }

    /** Un seul PowerShell pour toute la durée du serveur (lancer powershell toutes les 2,5 s coûterait cher). */
    startWindows() {
        const script = `$owner = ${process.pid}
while ($true) {
    if (-not (Get-Process -Id $owner -ErrorAction SilentlyContinue)) { exit }
    Get-CimInstance Win32_Process | ForEach-Object {
        "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)"
        if ($_.Name -match '^(ssh|wsl)\.exe$') { "CMD $($_.ProcessId)\`t$($_.CommandLine)" }
    }
    "---"
    Start-Sleep -Milliseconds ${INTERVAL_MS}
}`;
        this.ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        this.ps.stderr.on("data", (d) => { this.lastError = `${this.lastError ?? ""}${d}`.slice(-2000); });
        let lines = [];
        let rest = "";
        this.ps.stdout.on("data", (chunk) => {
            const parts = (rest + chunk).split(/\r?\n/);
            rest = parts.pop();
            for (const line of parts) {
                const cmd = /^CMD (\d+)\t(.*)$/.exec(line);
                if (cmd) { this.cmds.set(Number(cmd[1]), cmd[2]); continue; }
                if (line === "---") {
                    this.update(lines.map((l) => /^(\d+)\s+(\d+)\s+(.+)$/.exec(l)).filter(Boolean)
                        .map(([, pid, ppid, name]) => ({ pid: +pid, ppid: +ppid, name: base(name) })));
                    lines = [];
                } else {
                    lines.push(line);
                }
            }
        });
        // Arrêt du PowerShell (antivirus, EDR, erreur) : relance après 5 s, 20 fois par heure au plus
        this.ps.on("exit", (code, signal) => {
            this.ps = null;
            this.lastExit = { at: new Date().toISOString(), code, signal };
            const now = Date.now();
            this.restarts = (this.restarts ?? []).filter((t) => now - t < 3600e3);
            console.warn(`Surveillance ssh / wsl arrêtée (code ${code}${signal ? `, ${signal}` : ""})${this.lastError ? ` : ${this.lastError.trim().split("\n").pop()}` : ""}`);
            if (this.stopped || this.restarts.length >= 20) return;
            this.restarts.push(now);
            setTimeout(() => { if (!this.stopped && !this.ps) this.startWindows(); }, 5000).unref?.();
        });
    }

    /** Calcule l'état de chaque terminal à partir de la liste des processus ; émet "change" s'il a changé. */
    update(procs) {
        this.lastUpdate = Date.now();
        this.lastProcs = procs;
        this.emit("procs", procs);   // aussi utilisé par server/screenlock.mjs (écran de verrouillage Windows)
        const byPid = new Map(procs.map((p) => [p.pid, p]));
        const children = new Map();
        for (const p of procs) {
            if (!children.has(p.ppid)) children.set(p.ppid, []);
            children.get(p.ppid).push(p);
        }
        const next = new Map();
        const pids = new Map();
        // Processus Windows de chaque terminal (le shell et tous ses descendants) : rattachement des ssh « orphelins »
        const owner = new Map();
        for (const [sid, session] of this.terminals.sessions) {
            const stack = [session.proc?.pid].filter(Boolean);
            while (stack.length) {
                const pid = stack.pop();
                if (owner.has(pid)) continue;
                owner.set(pid, sid);
                stack.push(...(children.get(pid) ?? []).map((c) => c.pid));
            }
        }
        for (const [sid, session] of this.terminals.sessions) {
            const root = session.proc?.pid;
            if (!root) continue;
            // Descendants du shell du terminal : un ssh / mosh / wsl dont le parent est un shell
            const stack = [...(children.get(root) ?? [])];
            while (stack.length) {
                const p = stack.pop();
                const kind = REMOTE[p.name];
                const parent = p.ppid === root ? { name: "shell" } : byPid.get(p.ppid);
                if (kind && parent && (parent.name === "shell" || SHELLS.has(parent.name))) {
                    next.set(sid, kind);
                    pids.set(sid, p.pid);
                    break;
                }
                stack.push(...(children.get(p.pid) ?? []));
            }
        }
        // ssh orphelins (parent Windows absent : Git Bash) : rattachés par la table MSYS (résultat gardé par pid)
        const orphans = procs.filter((p) => REMOTE[p.name] && !byPid.has(p.ppid) && ![...pids.values()].includes(p.pid));
        const unknown = [];
        for (const p of orphans) {
            const link = this.msysOwner.get(p.pid);
            if (link?.sid && this.terminals.sessions.has(link.sid) && !next.has(link.sid)) {
                next.set(link.sid, REMOTE[p.name]);
                pids.set(link.sid, p.pid);
            } else if (!link || (!link.sid && Date.now() - link.at > 10000)) unknown.push(p.pid);
        }
        const alivePids = new Set(procs.map((p) => p.pid));
        for (const pid of this.msysOwner.keys()) if (!alivePids.has(pid)) this.msysOwner.delete(pid);
        if (unknown.length && (platform === "windows" || this.msysRun)) this.linkMsys(unknown, owner);
        const changed = next.size !== this.state.size || [...next].some(([sid, kind]) => this.state.get(sid) !== kind);
        this.state = next;
        this.pids = pids;
        // Lignes de commande des processus disparus : oubliées (celles d'un ssh pas encore rattaché sont gardées)
        for (const pid of this.cmds.keys()) if (!alivePids.has(pid)) this.cmds.delete(pid);
        // macOS / Linux : lecture ciblée des lignes de commande manquantes (Windows : déjà fournies par PowerShell)
        const missing = [...pids.values()].filter((pid) => !this.cmds.has(pid));
        if (missing.length && platform !== "windows" && !this.readingArgs) {
            this.readingArgs = true;
            setTimeout(() => { this.readingArgs = false; }, 2000).unref?.();
            this.readArgsUnix(missing);
        }
        this.resolveTargets(changed);   // un seul « change » : type de connexion et destination ensemble
    }
}
