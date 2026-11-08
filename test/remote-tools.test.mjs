import assert from "node:assert/strict";
import { test } from "node:test";

import { RemoteWatch } from "../server/remote.mjs";
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

test("outils vérifiés : ceux qui ont une commande d'installation sur ce système", () => {
    assert.equal(neededTool({ tool: "lazygit" }), "lazygit");
    assert.equal(neededTool({ tool: "git", needs: "delta" }), "delta");
    assert.equal(neededTool({ tool: "systemctl" }), null);
    if (process.platform === "win32") assert.equal(neededTool({ tool: "ansible-lint" }), null);
});
