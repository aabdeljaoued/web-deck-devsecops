import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { addDays, cleanVm, daysUntil, Patches, today } from "../server/patches.mjs";
import { StatusHub } from "../server/status.mjs";
import { tmpDir } from "./helpers.mjs";

test("VM : champs vérifiés, prochain patch déduit du dernier et de la fréquence", () => {
    const vm = cleanVm({ name: " app-prod-01 ", env: "production", lastPatch: "2026-10-01", everyDays: 30, description: "API\npaiement" });
    assert.deepEqual(vm, { name: "app-prod-01", host: "", identity: "", env: "production", description: "API paiement", tags: [], cluster: "", clusterSet: "", profile: "", role: "", decommissioned: false, decommissionedAt: "", lastPatch: "2026-10-01", nextPatch: "2026-10-31", everyDays: 30, check: null });
    // Cluster, ClusterSet, profil (saisie libre normalisée)
    const node = cleanVm({ name: "mysql-rec-02", nextPatch: "2026-12-01", cluster: " CL-MYSQL-APP-REC ", clusterSet: "CS_MYSQL_APP", profile: "MySQL" });
    assert.deepEqual([node.cluster, node.clusterSet, node.profile], ["CL-MYSQL-APP-REC", "CS_MYSQL_APP", "mysql-innodb"]);
    assert.throws(() => cleanVm({ name: "a", nextPatch: "2026-12-01", cluster: "CL; rm -rf /" }), /cluster invalide/);
    assert.throws(() => cleanVm({ name: "a", nextPatch: "2026-12-01", profile: "oracle-rac" }), /profil inconnu/);
    // Rôle : primary / secondary (alias), ignoré hors cluster
    assert.equal(cleanVm({ name: "a", nextPatch: "2026-12-01", cluster: "CL-1", role: "Primaire" }).role, "primary");
    assert.equal(cleanVm({ name: "a", nextPatch: "2026-12-01", cluster: "CL-1", role: "replica" }).role, "secondary");
    assert.equal(cleanVm({ name: "a", nextPatch: "2026-12-01", role: "primary" }).role, "", "sans cluster : pas de rôle");
    assert.throws(() => cleanVm({ name: "a", nextPatch: "2026-12-01", cluster: "CL-1", role: "arbitre" }), /rôle inconnu/);
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

test("inventaire : nom unique, prochain patch facultatif (« à planifier »), « patché » recalcule, rechargement", () => {
    const file = path.join(tmpDir(), "patches.json");
    const p = new Patches(file);
    const sansDate = p.save({ name: "sans-date-01" });   // pas de prochain patch : acceptée, « à planifier »
    assert.equal(p.get(sansDate).nextPatch, "");
    p.remove(sansDate);
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
    // Ligne sans date de patch : importée (« à planifier ») ; date impossible : refusée
    assert.deepEqual(vms.map((v) => [v.line, v.vm.name, v.vm.env, v.vm.nextPatch]), [[2, "app-01", "production", "2026-11-09"], [3, "db-01", "recette", "2026-12-15"], [6, "vide-01", "autre", ""]]);
    assert.equal(vms[0].vm.description, "API; paiement");
    assert.equal(errors.length, 2);
    assert.match(errors[0], /^ligne 4 : le nom/);
    assert.match(errors[1], /^ligne 5 : prochain patch : date invalide/);
    assert.throws(() => vmsFromCsv("hote,env\nx,prod"), /colonne « nom » introuvable/);
    const en = vmsFromCsv("name,host,next,every\nsrv-1,srv-1.lan,2026-12-01,15").vms[0].vm;
    assert.deepEqual([en.name, en.host, en.nextPatch, en.everyDays], ["srv-1", "srv-1.lan", "2026-12-01", 15]);
    // Colonnes cluster, ClusterSet, profil ; aller-retour par l'export
    const { vmsToCsv } = await import("../server/patches.mjs");
    const mysql = vmsFromCsv("nom;prochain_patch;cluster;clusterset;profil\nmysql-rec-01;01/12/2026;CL-MYSQL-APP-REC;CS_MYSQL_APP;MySQL").vms[0].vm;
    assert.deepEqual([mysql.cluster, mysql.clusterSet, mysql.profile], ["CL-MYSQL-APP-REC", "CS_MYSQL_APP", "mysql-innodb"]);
    const back = vmsFromCsv(vmsToCsv([mysql])).vms[0].vm;
    assert.deepEqual([back.cluster, back.clusterSet, back.profile], ["CL-MYSQL-APP-REC", "CS_MYSQL_APP", "mysql-innodb"]);
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

test("cluster : un seul PRIMARY (bascule à l'enregistrement, et à l'import)", async () => {
    const { vmsFromCsv } = await import("../server/patches.mjs");
    const p = new Patches(path.join(tmpDir(), "patches.json"));
    const node = (name, role) => ({ name, nextPatch: "2026-12-01", cluster: "CL-REC", role });
    p.save(node("n1", "primary"));
    p.save(node("n2", "secondary"));
    const id3 = p.save(node("n3", "secondary"));
    assert.deepEqual(p.lastDemoted, []);
    p.save({ id: id3, ...node("n3", "primary") });   // bascule : n3 devient PRIMARY
    assert.deepEqual(p.lastDemoted, ["n1"]);
    assert.deepEqual(p.list().map((v) => `${v.name}:${v.role}`).sort(), ["n1:secondary", "n2:secondary", "n3:primary"]);
    p.save({ name: "autre", nextPatch: "2026-12-01", cluster: "CL-TST", role: "primary" });
    assert.equal(p.list().find((v) => v.name === "n3").role, "primary", "autre cluster : pas touché");
    // Import : deux PRIMARY dans le même cluster -> le dernier du fichier gagne, signalé
    const { vms } = vmsFromCsv("nom;prochain_patch;cluster;role\nn1;01/12/2026;CL-REC;primary\nn2;01/12/2026;CL-REC;primary");
    const res = p.importMany(vms);
    assert.match(res.errors.join(), /CL-REC : un seul PRIMARY possible, gardé n2/);
    assert.deepEqual(p.list().filter((v) => v.cluster === "CL-REC").map((v) => `${v.name}:${v.role}`).sort(), ["n1:secondary", "n2:primary", "n3:secondary"]);
});

test("VM décommissionnée : gardée, sans date de patch exigée, hors suivi, à la fin ; perd son rôle ; CSV aller-retour", async () => {
    const { vmsFromCsv, vmsToCsv, isDecom } = await import("../server/patches.mjs");
    assert.ok(isDecom("oui") && isDecom("oui 14/11/2026") && isDecom("x") && isDecom("Décommissionnée") && isDecom(true));
    assert.ok(!isDecom("") && !isDecom("non") && !isDecom(false));
    const p = new Patches(path.join(tmpDir(), "patches.json"));
    const a = p.save({ name: "mysql-rec-01", nextPatch: "2026-12-01", cluster: "CL-REC", role: "primary" });
    p.save({ name: "mysql-rec-02", nextPatch: "2026-12-05", cluster: "CL-REC", role: "secondary" });
    p.save({ name: "vieille-vm", decommissioned: true, decommissionedAt: "2026-11-01" });   // pas de date de patch : accepté
    const vm = p.setDecommissioned(a, true);
    assert.equal(vm.role, "", "un PRIMARY décommissionné perd son rôle");
    assert.equal(vm.decommissionedAt, (await import("../server/patches.mjs")).today());
    assert.deepEqual(p.list().map((v) => v.name), ["mysql-rec-02", "mysql-rec-01", "vieille-vm"], "décommissionnées à la fin");
    assert.deepEqual(p.active().map((v) => v.name), ["mysql-rec-02"]);
    p.setDecommissioned(a, false);
    assert.deepEqual(p.active().map((v) => v.name).sort(), ["mysql-rec-01", "mysql-rec-02"]);
    // CSV : export « oui JJ/MM/AAAA », réimporté à l'identique ; ligne sans date de patch acceptée si décommissionnée
    const back = vmsFromCsv(vmsToCsv(p.list())).vms.map(({ vm: v }) => `${v.name}:${v.decommissioned}:${v.decommissionedAt}`);
    assert.ok(back.includes("vieille-vm:true:2026-11-01"), back.join());
    assert.equal(vmsFromCsv("nom;decom\nancienne;oui").vms.length, 1);
});

test("voyant patchs : les VMs décommissionnées ne comptent pas", () => {
    const hub = new StatusHub({ cfg: {}, apps: {}, containerCli: ["docker"] });
    hub.patchAlertFile = path.join(tmpDir(), "alerts.json");
    const p = new Patches(path.join(tmpDir(), "patches.json"));
    p.save({ name: "en-retard", nextPatch: "2020-01-01" });
    p.save({ name: "ok", nextPatch: addDays(today(), 30) });
    p.setDecommissioned(p.list().find((v) => v.name === "en-retard").id, true);
    hub.patchList = () => p.active();
    hub.refreshPatches();
    assert.equal(hub.states.patches.footer, "ok");
    assert.equal(hub.states.patches.bg, "#2E7D32");
});

test("VIPs d'un cluster : saisie « adresse[:port] [libellé] », contrôles, enregistrement, import de la configuration", async () => {
    const { cleanVip, cleanClusters } = await import("../server/patches.mjs");
    assert.deepEqual(cleanVip("10.0.0.10:3306 RW"), { address: "10.0.0.10", port: 3306, label: "RW" });
    assert.deepEqual(cleanVip("vip-mysql-rec.example.test router lecture"), { address: "vip-mysql-rec.example.test", port: null, label: "router lecture" });
    assert.deepEqual(cleanVip({ address: "fd00::10", port: "6446" }), { address: "fd00::10", port: 6446, label: "" });
    assert.throws(() => cleanVip("10.0.0.10;rm -rf /"), /VIP invalide/);
    assert.throws(() => cleanVip("10.0.0.10:99999"), /port invalide/);
    assert.throws(() => cleanVip("10.0.0.10 $(id)"), /libellé invalide/);
    const file = path.join(tmpDir(), "patches.json");
    const p = new Patches(file);
    p.save({ name: "mysql-rec-01", nextPatch: "2026-12-01", cluster: "CL-MYSQL-APP-REC" });
    assert.throws(() => p.setVips("CL-INCONNU", ["10.0.0.10"]), /cluster inconnu/);
    assert.throws(() => p.setVips("CL-MYSQL-APP-REC", ["10.0.0.10:3306", "10.0.0.10:3306 RW"]), /en double/);
    p.setVips("CL-MYSQL-APP-REC", ["10.0.0.10:3306 RW", "10.0.0.10:3307 RO"]);
    assert.equal(new Patches(file).clusters["CL-MYSQL-APP-REC"].vips.length, 2, "gardées après rechargement");
    p.setVips("CL-MYSQL-APP-REC", []);
    assert.deepEqual(new Patches(file).clusters, {}, "liste vide : retirées");
    // Import de la configuration complète : VMs et VIPs ; entrées invalides ignorées
    p.replace(p.list(), { "CL-MYSQL-APP-REC": { vips: [{ address: "10.0.0.20", port: 6446, label: "router" }, { address: "bad;x" }] }, "nom invalide !": { vips: ["1.2.3.4"] } });
    assert.deepEqual(new Patches(file).clusters, { "CL-MYSQL-APP-REC": { vips: [{ address: "10.0.0.20", port: 6446, label: "router" }] } });
    assert.deepEqual(cleanClusters(null), {});
});
