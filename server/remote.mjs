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

/** Nom de programme sans chemin ni .exe, en minuscules (« /usr/bin/ssh » ou « ssh.exe » -> « ssh »). */
const base = (name) => path.basename(String(name).trim().replace(/\\/g, "/")).toLowerCase().replace(/\.exe$/, "").replace(/^-/, "");

export class RemoteWatch extends EventEmitter {
    /** @param terminals server/terminal.mjs (sessions : sid -> { proc }) */
    constructor(terminals) {
        super();
        this.terminals = terminals;
        this.state = new Map();   // sid -> "ssh" | "wsl"
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
    Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }
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
                    break;
                }
                stack.push(...(children.get(p.pid) ?? []));
            }
        }
        const changed = next.size !== this.state.size || [...next].some(([sid, kind]) => this.state.get(sid) !== kind);
        this.state = next;
        if (changed) this.emit("change", this.view());
    }
}
