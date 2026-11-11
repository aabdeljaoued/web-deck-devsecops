import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { cleanCheck, Patches } from "../server/patches.mjs";
import { buildReport } from "../server/report.mjs";
import { agendaEvents, buildSummary, parcMarkdown, toIcs } from "../server/summary.mjs";
import { checkVm, parseCheck, sshArgs, sshError } from "../server/vmcheck.mjs";
import { tmpDir } from "./helpers.mjs";

const NOW = new Date("2026-11-11T10:00:00");
const vms = [
    { id: "vm-00000001", name: "app-prod-01", host: "admin@10.0.0.5", env: "production", description: "API; paiement", lastPatch: "2026-11-05", nextPatch: "2026-11-09", everyDays: 30, tags: [], check: { at: "2026-11-10T08:00:00Z", updates: 12, security: 3, reboot: true } },
    { id: "vm-00000002", name: "web-recette-01", host: "", env: "recette", description: "", lastPatch: "2026-10-01", nextPatch: "2026-12-20", everyDays: null, tags: [], check: null }
];
const certs = [
    { target: "api.client.test", env: "production", level: "orange", days: 20, until: "2026-12-01T12:00:00Z", issuer: "CA Test" },
    { target: "rec.client.test", env: "recette", level: "ok", days: 200, until: "2027-05-30T12:00:00Z" },
    { target: "down.client.test", env: "production", error: "délai dépassé" }
];

test("échéances : patchs et certificats triés par date, certificats injoignables ignorés", () => {
    const ev = agendaEvents({ vms, certs, now: NOW });
    assert.deepEqual(ev.map((e) => `${e.date} ${e.kind} ${e.env} ${e.level}`), [
        "2026-11-09 patch production rouge", "2026-12-01 certificat production orange", "2026-12-20 patch recette ok", "2027-05-30 certificat recette ok"
    ]);
});

test("export .ics : journée entière, rappel 3 j en production / 1 j sinon, texte échappé, lignes de 75 octets", () => {
    const ics = toIcs(agendaEvents({ vms, certs, now: NOW }), { name: "Échéances", now: NOW });
    assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
    assert.match(ics, /END:VCALENDAR\r\n$/);
    assert.equal(ics.match(/BEGIN:VEVENT/g).length, 4);
    assert.match(ics, /DTSTART;VALUE=DATE:20261109\r\nDTEND;VALUE=DATE:20261110/);
    assert.match(ics, /SUMMARY:\[PROD\] Patch app-prod-01/);
    assert.match(ics, /SUMMARY:\[recette\] Patch web-recette-01/);
    assert.ok(ics.includes("DESCRIPTION:API\\; paiement"), "point-virgule échappé");
    assert.deepEqual(ics.match(/TRIGGER:-P\dD/g), ["TRIGGER:-P3D", "TRIGGER:-P3D", "TRIGGER:-P1D", "TRIGGER:-P1D"]);
    for (const line of ics.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75, line);
    // UID stable : réimporter met à jour sans dupliquer
    assert.equal(toIcs(agendaEvents({ vms, certs, now: NOW })).match(/UID:.*/g).join(), ics.match(/UID:.*/g).join());
});

test("état du parc et synthèse : par environnement, éléments à traiter, actions en production", () => {
    const parc = parcMarkdown({ vms, certs, now: NOW });
    assert.match(parc, /\| \*\*production\*\* \| 2 \| 0 \| 1 \| 1 \|/, "certificats de production : 1 orange, 1 injoignable");
    assert.match(parc, /`app-prod-01` \(production\) : \*\*patch en retard de 2 j\*\* · 12 MAJ en attente dont 3 de sécurité · reboot requis/);
    const md = buildSummary({ mission: "Client Démo", kube: { context: "prod-eu", namespace: "app", prod: true }, vms, certs, now: NOW,
        entries: [{ time: "2026-11-10T09:00:00", label: "rollout", command: "kubectl rollout restart deploy/api", kube: "prod-eu / app", prod: true },
            { time: "2026-10-01T09:00:00", label: "ancien", command: "x", prod: true }] });
    assert.match(md, /^# Synthèse : Client Démo/);
    assert.match(md, /prod-eu \/ app \(\*\*PRODUCTION\*\*\)/);
    assert.match(md, /Actions en production \(7 derniers jours\)\*\* : 1/);
    assert.match(md, /\| 09\/11\/2026 \| Patch app-prod-01 \| \*\*production\*\* \|/);
    assert.doesNotMatch(md, /20\/12\/2026/, "au-delà de 30 jours : pas dans les échéances");
});

test("rapport : patchs réalisés sur la période et état du parc", () => {
    const md = buildReport({ from: new Date("2026-11-01T00:00:00"), to: NOW, vms, certs });
    assert.match(md, /VMs patchées\*\* : 1 \(dont \*\*1 en production\*\*\)/);
    assert.match(md, /\| 05\/11\/2026 \| app-prod-01 \| \*\*production\*\* \| API; paiement \| 09\/11\/2026 \|/);
    assert.doesNotMatch(md, /\| 01\/10\/2026 \| web-recette-01/, "patch hors période");
    assert.match(md, /## État du parc à date/);
    assert.doesNotMatch(buildReport({ from: NOW, to: NOW }), /État du parc/, "sans inventaire : section absente");
});

test("vérification d'une VM : arguments sûrs, sortie lue, erreurs en clair", () => {
    assert.deepEqual(sshArgs({ name: "a", host: "admin@10.0.0.5", identity: "" }).slice(-4), ["--", "admin@10.0.0.5", "sh", "-s"]);
    assert.ok(sshArgs({ name: "a", host: "h", identity: "/k" }).includes("BatchMode=yes"));
    assert.throws(() => sshArgs({ name: "-oProxyCommand", host: "" }), /hôte invalide/);
    const r = parseCheck("OS=Ubuntu 24.04.1 LTS\nKERNEL=6.8.0-45\nUPTIME=950400\nMANAGER=apt\nUPDATES=12\nSECURITY=3\nREBOOT=1\nEND=ok\n", NOW);
    assert.deepEqual({ ...r, at: undefined }, { at: undefined, os: "Ubuntu 24.04.1 LTS", kernel: "6.8.0-45", uptimeDays: 11, manager: "apt", updates: 12, security: 3, reboot: true });
    assert.equal(parseCheck("Microsoft Windows\r\n'sh' is not recognized"), null);
    assert.match(sshError("Host key verification failed."), /clé d'hôte inconnue/);
    assert.match(sshError("admin@h: Permission denied (publickey)."), /jamais de mot de passe/);
    assert.deepEqual(cleanCheck({ at: NOW, updates: "7", security: -2, reboot: "oui", os: "x\u0007y" }),
        { at: NOW.toISOString(), os: "x y", kernel: "", uptimeDays: null, manager: "", updates: 7, security: 0, reboot: false });
});

test("vérification : faux ssh, résultat enregistré ; modifier la VM le garde, « Patché » l'efface", { skip: process.platform === "win32" }, async () => {
    const dir = tmpDir();
    const fake = path.join(dir, "ssh");
    writeFileSync(fake, "#!/bin/sh\ncat >/dev/null\nprintf 'OS=Rocky 9\\nKERNEL=5.14\\nMANAGER=dnf\\nUPDATES=4\\nSECURITY=1\\nREBOOT=0\\nEND=ok\\n'\n");
    chmodSync(fake, 0o755);
    const res = await checkVm({ name: "db-01", host: "db-01", identity: "" }, { ssh: fake });
    assert.equal(res.updates, 4);
    const refused = path.join(dir, "ssh-ko");
    writeFileSync(refused, "#!/bin/sh\ncat >/dev/null\necho 'db-01: Permission denied (publickey).' >&2\nexit 255\n");
    chmodSync(refused, 0o755);
    assert.match((await checkVm({ name: "db-01", host: "", identity: "" }, { ssh: refused })).error, /connexion refusée/);

    const p = new Patches(path.join(dir, "patches.json"));
    const id = p.save({ name: "db-01", nextPatch: "2026-12-01", everyDays: 30 });
    p.setCheck(id, res);
    p.save({ id, name: "db-01", nextPatch: "2026-12-01", everyDays: 30, description: "modifiée" });
    assert.equal(new Patches(path.join(dir, "patches.json")).get(id).check.updates, 4, "gardé après modification et rechargement");
    p.save({ id, name: "db-01", host: "autre-hote", nextPatch: "2026-12-01", everyDays: 30 });
    assert.equal(p.get(id).check, null, "hôte changé : vérification effacée");
    p.setCheck(id, res);
    p.markPatched(id);
    assert.equal(p.get(id).check, null, "patchée : à re-vérifier");
});
