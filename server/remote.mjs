// Connexions distantes dans les terminaux : un terminal est « distant » quand une session ssh (ou mosh, ou wsl)
// y a été lancée depuis un shell. Sert aux rubriques qui demandent un shell Linux / macOS (Ansible sous Windows) :
// leurs touches s'activent quand le terminal actif est connecté à une machine Linux ou macOS.
// Un ssh lancé par un autre programme (git push, scp, rsync…) ne compte pas : seul celui dont le parent est un shell.
import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
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

/** Distribution d'une commande wsl (wsl -d Ubuntu) ; null = distribution par défaut. */
export function wslTarget(cmdline) {
    const argv = words(cmdline);
    const i = argv.findIndex((a) => a === "-d" || a === "--distribution");
    return i >= 0 && argv[i + 1] ? argv[i + 1].slice(0, 60) : null;
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
        this.timer = null;
        this.ps = null;           // Windows : PowerShell qui liste les processus en boucle
    }

    start() {
        if (platform === "windows") return this.startWindows();
        this.timer = setInterval(() => this.pollUnix(), INTERVAL_MS);
        this.timer.unref();
    }

    stop() {
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
        this.ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
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
        this.ps.on("exit", () => { this.ps = null; });
    }

    /** Calcule l'état de chaque terminal à partir de la liste des processus ; émet "change" s'il a changé. */
    update(procs) {
        this.emit("procs", procs);   // aussi utilisé par server/screenlock.mjs (écran de verrouillage Windows)
        const byPid = new Map(procs.map((p) => [p.pid, p]));
        const children = new Map();
        for (const p of procs) {
            if (!children.has(p.ppid)) children.set(p.ppid, []);
            children.get(p.ppid).push(p);
        }
        const next = new Map();
        const pids = new Map();
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
        const changed = next.size !== this.state.size || [...next].some(([sid, kind]) => this.state.get(sid) !== kind);
        this.state = next;
        this.pids = pids;
        // Lignes de commande des connexions terminées : oubliées
        const alive = new Set(pids.values());
        for (const pid of this.cmds.keys()) if (!alive.has(pid)) this.cmds.delete(pid);
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
