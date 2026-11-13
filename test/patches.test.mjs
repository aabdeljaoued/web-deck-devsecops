import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { addDays, cleanVm, daysUntil, Patches, today } from "../server/patches.mjs";
import { StatusHub } from "../server/status.mjs";
import { tmpDir } from "./helpers.mjs";

test("VM : champs vérifiés, prochain patch déduit du dernier et de la fréquence", () => {
    const vm = cleanVm({ name: " app-prod-01 ", env: "production", lastPatch: "2026-10-01", everyDays: 30, description: "API\npaiement" });
    assert.deepEqual(vm, { name: "app-prod-01", host: "", identity: "", env: "production", description: "API paiement", tags: [], cluster: "", clusterSet: "", profile: "", lastPatch: "2026-10-01", nextPatch: "2026-10-31", everyDays: 30, check: null });
    // Cluster, ClusterSet, profil (saisie libre normalisée)
    const node = cleanVm({ name: "wqyd5530", nextPatch: "2026-12-01", cluster: " CL-MYSQL-LT1-REC ", clusterSet: "CS_MYSQL_LT1", profile: "MySQL" });
    assert.deepEqual([node.cluster, node.clusterSet, node.profile], ["CL-MYSQL-LT1-REC", "CS_MYSQL_LT1", "mysql-innodb"]);
    assert.throws(() => cleanVm({ name: "a", nextPatch: "2026-12-01", cluster: "CL; rm -rf /" }), /cluster invalide/);
    assert.throws(() => cleanVm({ name: "a", nextPatch: "2026-12-01", profile: "oracle-rac" }), /profil inconnu/);
    // Tags libres : séparés par virgule, espace ou |, en minuscules, sans doublon
    assert.deepEqual(cleanVm({ name: "a", nextPatch: "2026-12-01", tags: "Linux, DMZ  critique|#linux" }).tags, ["linux", "dmz", "critique"]);
    assert.throws(() => cleanVm({ name: "a", nextPatch: "2026-12-01", tags: "ok, pas<bon>" }), /tag invalide/);
    assert.throws(() => cleanVm({ name: "a", nextPatch: "2026-12-01", tags: "a b c d e f g h i j k" }), /10 tags/);
    // Clé SSH (ssh -i) : chemin tapé dans le terminal, sans caractère de shell
    assert.equal(cleanVm({ name: "a", nextPatch: "2026-12-01", identity: "\"/Users/jean dupont/.ssh/id_ed25519\"" }).identity, "/Users/jean dupont/.ssh/id_ed25519");
    assert.equal(cleanVm({ name: "a", nextPatch: "2026-12-01", identity: "C:\\Users\\its\\.ssh\\cle-prod" }).identity, "C:\\Users\\its\\.ssh\\cle-prod");
    for (const bad of ["~/.ssh/id; rm -rf ~", "$(whoami)", "`id`", "a|b", "a&b", "a'b"]) assert.throws(() => cleanVm({ name: "a", nextPatch: "2026-12-01", identity: bad }), /clé SSH/, bad);
    assert.throws(() => cleanVm({ name: "" }), /obligatoire/);
    assert.throws(() => cleanVm({ name: "a", nextPatch: "2026-02-30" }), /date invalide/);
    assert.throws(() => cleanVm({ name: "a", nextPatch: "2026-12-01", host: "a; rm -rf /" }), /hôte SSH invalide/);
    assert.throws(() => cleanVm({ name: "a", nextPatch: "2026-12-01", env: "prod" }), /environnement inconnu/);
    assert.throws(() => cleanVm({ name: "a", nextPatch: "2026-12-01", everyDays: 0 }), /fréquence/);
});

test("inventaire : nom unique, prochain patch obligatoire, « patché » recalcule, rechargement", () => {
    const file = path.join(tmpDir(), "patches.json");
    const p = new Patches(file);
    assert.throws(() => p.save({ name: "web-01" }), /prochain patch/);
    const id = p.save({ name: "web-01", lastPatch: "2026-10-01", everyDays: 15 });
    assert.throws(() => p.save({ name: "WEB-01", nextPatch: "2026-12-01" }), /s'appelle déjà/);
    p.save({ name: "db-01", nextPatch: "2026-11-20" });
    const vm = p.markPatched(id, "2026-11-05");
    assert.equal(vm.lastPatch, "2026-11-05");
    assert.equal(vm.nextPatch, "2026-11-20");
    const db = p.list().find((v) => v.name === "db-01");
    assert.equal(p.markPatched(db.id, "2026-11-25").nextPatch, "", "sans fréquence, prochain patch passé : à planifier");
    assert.deepEqual(new Patches(file).list().map((v) => v.name).sort(), ["db-01", "web-01"], "VM « à planifier » gardée au rechargement");
    p.remove(id);
    assert.equal(p.list().length, 1);
});

test("voyant patchs : rouge en retard ou à J-1, orange à J-7, alertes une fois par seuil", () => {
    const hub = new StatusHub({ cfg: {}, apps: {}, containerCli: ["docker"] });
    hub.patchAlertFile = path.join(tmpDir(), "alerts.json");
    const states = [];
    const alerts = [];
    hub.on("update", (id, s) => id === "patches" && states.push(s));
    hub.on("patch-alert", (a) => alerts.push(a.map((x) => `${x.target}:${x.level}`).join(",")));
    const d = today();
    let vms = [{ id: "vm-1", name: "app-01", env: "production", nextPatch: addDays(d, 20) }, { id: "vm-2", name: "db-01", env: "recette", nextPatch: addDays(d, 5) }];
    hub.patchList = () => vms;
    hub.refreshPatches();
    assert.equal(states.at(-1).bg, "#EF6C00");
    assert.deepEqual(states.at(-1).lines, ["J-5"]);
    assert.equal(states.at(-1).footer, "db-01");
    vms = [vms[0], { ...vms[1], nextPatch: addDays(d, -2) }];
    hub.refreshPatches();
    assert.equal(states.at(-1).bg, "#C62828");
    assert.deepEqual(states.at(-1).lines, ["J+2"]);
    hub.refreshPatches();
    assert.deepEqual(alerts, ["db-01:orange", "db-01:rouge"], "une seule alerte par seuil");
    assert.equal(daysUntil(addDays(d, 3)), 3);
});

test("import CSV : séparateur « ; » ou « , », guillemets, en-têtes FR / EN, dates JJ/MM/AAAA, erreurs par ligne", async () => {
    const { parseCsv, vmsFromCsv } = await import("../server/patches.mjs");
    assert.deepEqual(parseCsv('a,"b, c","d ""e"""\n1,2,3').rows.map((r) => r.cells), [["a", "b, c", 'd "e"'], ["1", "2", "3"]]);
    const csv = "﻿Nom;Hôte;Clé SSH;Environnement;Dernier patch;Prochain patch;Fréquence;Description\r\n"
        + "app-01;admin@10.0.0.5;~/.ssh/id_ed25519;Prod;10/10/2026;;30;\"API; paiement\"\r\n"
        + "db-01;;;recette;;15/12/2026;;PostgreSQL\r\n"
        + ";x;;;;01/12/2026;;sans nom\r\n"
        + "web-01;;;production;;31/02/2026;;date impossible\r\n"
        + "vide-01;;;autre;;;;pas de date\r\n";
    const { vms, errors } = vmsFromCsv(csv);
    assert.deepEqual(vms.map((v) => [v.line, v.vm.name, v.vm.env, v.vm.nextPatch]), [[2, "app-01", "production", "2026-11-09"], [3, "db-01", "recette", "2026-12-15"]]);
    assert.equal(vms[0].vm.description, "API; paiement");
    assert.equal(errors.length, 3);
    assert.match(errors[0], /^ligne 4 : le nom/);
    assert.match(errors[1], /^ligne 5 : prochain patch : date invalide/);
    assert.match(errors[2], /^ligne 6 : prochain patch manquant/);
    assert.throws(() => vmsFromCsv("hote,env\nx,prod"), /colonne « nom » introuvable/);
    const en = vmsFromCsv("name,host,next,every\nsrv-1,srv-1.lan,2026-12-01,15").vms[0].vm;
    assert.deepEqual([en.name, en.host, en.nextPatch, en.everyDays], ["srv-1", "srv-1.lan", "2026-12-01", 15]);
    // Colonnes cluster, ClusterSet, profil ; aller-retour par l'export
    const { vmsToCsv } = await import("../server/patches.mjs");
    const mysql = vmsFromCsv("nom;prochain_patch;cluster;clusterset;profil\nwqyd5529;01/12/2026;CL-MYSQL-LT1-REC;CS_LT1;MySQL").vms[0].vm;
    assert.deepEqual([mysql.cluster, mysql.clusterSet, mysql.profile], ["CL-MYSQL-LT1-REC", "CS_LT1", "mysql-innodb"]);
    const back = vmsFromCsv(vmsToCsv([mysql])).vms[0].vm;
    assert.deepEqual([back.cluster, back.clusterSet, back.profile], ["CL-MYSQL-LT1-REC", "CS_LT1", "mysql-innodb"]);
});

test("import en masse : aperçu sans écriture, ajout ou mise à jour par nom, doublons du fichier, export réimportable", async () => {
    const { vmsFromCsv, vmsToCsv } = await import("../server/patches.mjs");
    const file = path.join(tmpDir(), "patches.json");
    const p = new Patches(file);
    p.save({ name: "app-01", nextPatch: "2026-11-30", description: "ancienne" });
    const { vms } = vmsFromCsv("nom;prochain_patch;tags;description\napp-01;01/12/2026;linux, dmz;nouvelle\nAPP-01;02/12/2026;;doublon\ndb-01;05/12/2026;postgres;base");
    const preview = p.importMany(vms, { dryRun: true });
    assert.deepEqual([preview.added, preview.updated], [1, 1]);
    assert.match(preview.errors[0], /ligne 3 : « APP-01 » apparaît deux fois/);
    assert.equal(new Patches(file).list().length, 1, "aperçu : rien n'est écrit");
    p.importMany(vms);
    const after = new Patches(file).list();
    assert.deepEqual(after.map((v) => `${v.name}:${v.nextPatch}:${v.description}:${v.tags.join("+")}`), ["app-01:2026-12-01:nouvelle:linux+dmz", "db-01:2026-12-05:base:postgres"]);
    // Export puis réimport : mêmes VMs, rien d'ajouté
    const again = vmsFromCsv(vmsToCsv(after));
    assert.deepEqual(again.errors, []);
    assert.deepEqual([p.importMany(again.vms, { dryRun: true }).added, p.importMany(again.vms, { dryRun: true }).updated], [0, 2]);
});
