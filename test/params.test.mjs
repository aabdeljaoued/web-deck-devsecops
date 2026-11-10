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

test("clés SSH pour ssh -i : fichiers avec .pub, .pem, .key ; pas les .pub ni les autres fichiers", async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = (await import("node:path")).default;
    const { sshKeys, liveParam } = await import("../server/params.mjs");
    const dir = mkdtempSync(path.join(tmpdir(), "deck keys-"));
    for (const f of ["id_ed25519", "id_ed25519.pub", "client.pem", "known_hosts", "config", "orphan.pub"]) writeFileSync(path.join(dir, f), "x");
    mkdirSync(path.join(dir, "old.key"));
    assert.deepEqual(sshKeys(dir), [`"${path.join(dir, "client.pem")}"`, `"${path.join(dir, "id_ed25519")}"`]);
    assert.equal(liveParam("identité"), "identity");
});

test("ports d'un service : rien sans service, noms vérifiés avant kubectl", async () => {
    const { paramOptions, liveParam } = await import("../server/params.mjs");
    assert.equal(liveParam("port"), "port");
    assert.deepEqual(await paramOptions({ apps: { kubectl: "/bin/echo" } }, "port", { namespace: "app" }), []);
    await assert.rejects(paramOptions({ apps: { kubectl: "/bin/echo" } }, "port", { namespace: "app", service: "--all" }), /service invalide/);
});

test("clés SSH sans .pub (cas Windows) : nom classique ou en-tête de clé privée ; dossier vide signalé", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = (await import("node:path")).default;
    const { sshKeys } = await import("../server/params.mjs");
    const dir = mkdtempSync(path.join(tmpdir(), "deck-keys-win-"));
    writeFileSync(path.join(dir, "id_rsa"), "x");                                         // nom classique, sans .pub
    writeFileSync(path.join(dir, "serveur-client"), "-----BEGIN OPENSSH PRIVATE KEY-----\r\nb3Blbn\r\n");
    writeFileSync(path.join(dir, "ancienne"), "-----BEGIN RSA PRIVATE KEY-----\n");
    writeFileSync(path.join(dir, "notes.txt"), "-----BEGIN OPENSSH PRIVATE KEY-----\n");   // .txt ignoré
    writeFileSync(path.join(dir, "putty.ppk"), "PuTTY-User-Key-File-3: ssh-ed25519\n");      // format PuTTY, inutilisable avec -i
    writeFileSync(path.join(dir, "known_hosts"), "github.com ssh-ed25519 AAAA\n");
    writeFileSync(path.join(dir, "divers"), "rien à voir\n");
    assert.deepEqual(sshKeys(dir).map((p) => path.basename(p.replace(/"/g, ""))), ["ancienne", "id_rsa", "serveur-client"]);
    assert.throws(() => sshKeys(mkdtempSync(path.join(tmpdir(), "deck-keys-vide-"))), /aucune clé privée dans/);
    assert.throws(() => sshKeys(path.join(dir, "absent")), /dossier introuvable/);
});
