import assert from "node:assert/strict";
import { test } from "node:test";

import { liveParam, paramOptions } from "../server/params.mjs";

test("paramètres à liste réelle : noms et alias reconnus, les autres non", () => {
    assert.equal(liveParam("namespace"), "namespace");
    assert.equal(liveParam("NS"), "namespace");
    assert.equal(liveParam("svc"), "service");
    assert.equal(liveParam("deploy"), "deployment");
    assert.equal(liveParam("conteneur"), "container");
    assert.equal(liveParam("durée"), null);
});

test("paramètre sans liste réelle : aucune valeur, aucune commande lancée", async () => {
    assert.deepEqual(await paramOptions({ apps: {} }, "durée"), []);
});

test("namespace transmis à kubectl : vérifié (pas d'option injectée)", async () => {
    await assert.rejects(paramOptions({ apps: { kubectl: "/bin/echo" } }, "pod", { namespace: "-n x" }), /namespace invalide/);
});

test("hôtes SSH : lignes Host sans motifs, Include suivis, rien d'exécuté", async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = (await import("node:path")).default;
    const { sshHosts } = await import("../server/params.mjs");
    const dir = mkdtempSync(path.join(tmpdir(), "deck-ssh-"));
    mkdirSync(path.join(dir, "conf.d"));
    writeFileSync(path.join(dir, "conf.d", "client.conf"), "Host bastion-client app-1\n  HostName 10.0.0.1\n");
    writeFileSync(path.join(dir, "config"), `Host *\n  ServerAliveInterval 30\nHost github.com gitlab-*  # commentaire\nHost=prod-db\nInclude ${path.join(dir, "conf.d", "*.conf")}\nInclude ${path.join(dir, "config")}\n`);
    assert.deepEqual(sshHosts(path.join(dir, "config")), ["github.com", "prod-db", "bastion-client", "app-1"]);
    assert.deepEqual(sshHosts(path.join(dir, "absent")), []);
});
