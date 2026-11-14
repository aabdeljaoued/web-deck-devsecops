import assert from "node:assert/strict";
import { test } from "node:test";

import { parseMsysPs, RemoteWatch, splitTarget, sshTarget, wslTarget } from "../server/remote.mjs";
import { neededTool } from "../server/tools.mjs";

/** Terminal factice (shell pid 100) et liste de processus : seul un ssh lancé depuis un shell compte. */
function detect(procs) {
    const w = new RemoteWatch({ sessions: new Map([["1", { proc: { pid: 100 } }]]) });
    w.update(procs);
    return w.view()["1"] ?? null;
}

test("ssh / wsl lancés depuis le shell du terminal : détectés", () => {
    assert.equal(detect([{ pid: 101, ppid: 100, name: "ssh" }]), "ssh");
    assert.equal(detect([{ pid: 101, ppid: 100, name: "zsh" }, { pid: 102, ppid: 101, name: "ssh" }]), "ssh");
    assert.equal(detect([{ pid: 101, ppid: 100, name: "wsl" }]), "wsl");
});

test("ssh lancé par git push ou scp : ignoré", () => {
    assert.equal(detect([{ pid: 101, ppid: 100, name: "git" }, { pid: 102, ppid: 101, name: "ssh" }]), null);
    assert.equal(detect([{ pid: 101, ppid: 100, name: "scp" }, { pid: 102, ppid: 101, name: "ssh" }]), null);
    assert.equal(detect([{ pid: 101, ppid: 999, name: "ssh" }]), null, "ssh d'un autre terminal");
});

test("destination d'une commande ssh : options à valeur sautées, utilisateur gardé, rien d'autre", () => {
    assert.equal(sshTarget("ssh admin@app-prod-01.client.test"), "admin@app-prod-01.client.test");
    assert.equal(sshTarget("/usr/bin/ssh -i ~/.ssh/cle-prod -p 2222 -o StrictHostKeyChecking=yes admin@10.0.0.5 uptime"), "admin@10.0.0.5");
    assert.equal(sshTarget('C:\\Windows\\System32\\OpenSSH\\ssh.exe -i "C:\\Users\\jean dupont\\.ssh\\cle" bastion-client'), "bastion-client");
    assert.equal(sshTarget("ssh -l root -tt db-prod-01"), "root@db-prod-01");
    assert.equal(sshTarget("ssh -p2222 -J saut@bastion web-01"), "web-01");
    assert.equal(sshTarget("ssh -v -- srv-ad-01"), "srv-ad-01");
    assert.equal(sshTarget("ssh ssh://ops@host.test:2200"), "ops@host.test");
    assert.equal(sshTarget("ssh -i cle"), null);
    assert.equal(wslTarget("wsl.exe -d Ubuntu-24.04"), "Ubuntu-24.04");
    assert.equal(wslTarget("wsl.exe"), null);
});

test("terminal connecté : destination lue dans la ligne de commande (Windows) puis oubliée à la déconnexion", () => {
    const w = new RemoteWatch({ sessions: new Map([["1", { proc: { pid: 100 } }]]) });
    const events = [];
    w.on("change", () => events.push(JSON.stringify(w.targets())));
    w.cmds.set(101, "ssh.exe -i C:\\cle admin@app-prod-01");
    w.update([{ pid: 101, ppid: 100, name: "ssh" }]);
    assert.deepEqual(w.targets(), { 1: "admin@app-prod-01" });
    w.update([]);
    assert.deepEqual(w.targets(), {});
    assert.equal(w.cmds.size, 0, "ligne de commande oubliée");
    assert.deepEqual(events, ['{"1":"admin@app-prod-01"}', "{}"]);
});

test("bastion type PSMP : compte@cible@hôte@bastion -> VM cible, via le bastion", () => {
    const dest = sshTarget("ssh -i ~/.ssh/key.openssh compte01@root@mysql-rec-01.example.test@bastion-01.example.test");
    assert.equal(dest, "compte01@root@mysql-rec-01.example.test@bastion-01.example.test");
    assert.deepEqual(splitTarget(dest), { user: "root", host: "mysql-rec-01.example.test", via: "bastion-01.example.test" });
    assert.deepEqual(splitTarget("admin@app-01"), { user: "admin", host: "app-01", via: null });
    assert.deepEqual(splitTarget("app-01"), { user: null, host: "app-01", via: null });
});

test("diagnostic : lignée de chaque ssh et raison de la (non-)détection (Git Bash : lanceur bash -> bash -> ssh)", () => {
    const w = new RemoteWatch({ sessions: new Map([["1", { proc: { pid: 100 } }]]) });
    w.cmds.set(103, "ssh.exe admin@app-01");
    w.update([
        { pid: 101, ppid: 100, name: "bash" }, { pid: 102, ppid: 101, name: "bash" }, { pid: 103, ppid: 102, name: "ssh" },
        { pid: 201, ppid: 100, name: "git" }, { pid: 202, ppid: 201, name: "ssh" },
        { pid: 300, ppid: 1, name: "ssh" }
    ]);
    const seen = Object.fromEntries(w.explain().map((s) => [s.pid, s]));
    assert.equal(seen[103].detected, true);
    assert.equal(seen[103].dest, "admin@app-01");
    assert.deepEqual(seen[103].chain, ["bash", "bash", "terminal 1"]);
    assert.equal(seen[202].detected, false);
    assert.match(seen[202].why, /git.*pas un shell/);
    assert.equal(seen[300].why, "hors des terminaux du deck");
    assert.ok(w.lastUpdate > 0);
});

test("Git Bash : ssh dont le parent Windows a disparu, rattaché au terminal par la table de processus MSYS", async () => {
    // Terminal 1 : lanceur bin\bash.exe (100) -> usr\bin\bash.exe (101). Le ssh (300) a pour parent Windows 250, disparu.
    const msys = [
        "      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND",
        "     1717       1    1717        101  cons0     197609 09:40:00 /usr/bin/bash",
        "I    1730    1717    1730        300  cons0     197609 09:44:58 /usr/bin/ssh",
        "     1800       1    1800        999  cons1     197609 09:30:00 /usr/bin/bash"
    ].join("\r\n");
    assert.deepEqual(parseMsysPs(msys).map((r) => [r.pid, r.ppid, r.winpid]), [[1717, 1, 101], [1730, 1717, 300], [1800, 1, 999]]);
    const w = new RemoteWatch({ sessions: new Map([["1", { proc: { pid: 100 } }]]) });
    let reads = 0;
    w.msysRun = async () => { reads++; return msys; };
    w.cmds.set(300, '"C:\\Program Files\\Git\\usr\\bin\\ssh.exe" -i ~/.ssh/key compte@root@vm-01.example.test@bastion.example.test');
    const changes = [];
    w.on("change", (v) => changes.push(JSON.stringify(v)));
    const procs = [{ pid: 101, ppid: 100, name: "bash" }, { pid: 300, ppid: 250, name: "ssh" }];
    w.update(procs);
    assert.deepEqual(w.view(), {}, "1er relevé : filiation pas encore lue");
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(w.view(), { 1: "ssh" }, "rattaché au terminal 1 par MSYS");
    assert.equal(w.targets()[1], "compte@root@vm-01.example.test@bastion.example.test");
    w.update(procs);
    assert.equal(reads, 1, "filiation gardée : ps.exe pas relancé à chaque relevé");
    assert.match(w.explain()[0].chain.join(" "), /terminal 1 \(filiation Git Bash\)/);
    w.update([{ pid: 101, ppid: 100, name: "bash" }]);
    assert.deepEqual(w.view(), {}, "déconnecté");
    assert.equal(w.msysOwner.size, 0);
});

test("outils vérifiés : ceux qui ont une commande d'installation sur ce système", () => {
    assert.equal(neededTool({ tool: "systemctl" }), null);
    if (process.platform === "linux") {
        // Linux : aucune commande proposée (apt, dnf, pacman… selon la distribution), donc rien n'est vérifié
        assert.equal(neededTool({ tool: "lazygit" }), null);
        return;
    }
    assert.equal(neededTool({ tool: "lazygit" }), "lazygit");
    assert.equal(neededTool({ tool: "git", needs: "delta" }), "delta");
    if (process.platform === "win32") assert.equal(neededTool({ tool: "ansible-lint" }), null);
});

test("enregistrement de session : .cast asciinema, texte sans séquences ANSI, liste", async () => {
    const { Recorder, castToText } = await import("../server/recorder.mjs");
    const { tmpDir } = await import("./helpers.mjs");
    const { readFileSync } = await import("node:fs");
    const path = (await import("node:path")).default;
    const dir = path.join(tmpDir(), "rec");
    const r = new Recorder(dir);
    const file = r.start("1", { cols: 80, rows: 24, label: "zsh / client prod" });
    assert.match(file, /^\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d_zsh-client-prod\.cast$/);
    r.write("1", "\x1b[32mok\x1b[0m pods\r\n");
    r.write("1", "progress 10%\rprogress 100%\r\n");
    assert.deepEqual(r.sids(), ["1"]);
    const done = await r.stop("1");
    const cast = readFileSync(path.join(dir, done.cast), "utf8").split("\n");
    assert.equal(JSON.parse(cast[0]).version, 2);
    assert.equal(JSON.parse(cast[1])[1], "o");
    assert.equal(readFileSync(path.join(dir, done.txt), "utf8"), "ok pods\nprogress 100%\n");
    assert.equal(r.list()[0].name, done.cast);
    assert.equal(await r.stop("1"), null);
    assert.match(r.read(done.cast), /^\{"version":2/);
    for (const bad of ["../vault.enc", "x.txt", ".cast", "a/b.cast", done.txt]) assert.throws(() => r.read(bad), /invalide/, bad);
    assert.throws(() => r.read("absent.cast"), /introuvable/);
    assert.equal(castToText('{"version":2}\n[0.1,"o","\\u001b]0;titre\\u0007a"]\n'), "a");
});
