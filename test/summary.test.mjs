import assert from "node:assert/strict";
import { test } from "node:test";

import { buildReport } from "../server/report.mjs";
import { agendaEvents, buildSummary, parcMarkdown, toIcs } from "../server/summary.mjs";

const NOW = new Date("2026-11-11T10:00:00");
const vms = [
    { id: "vm-00000001", name: "app-prod-01", host: "admin@10.0.0.5", env: "production", description: "API; paiement", lastPatch: "2026-11-05", nextPatch: "2026-11-09", everyDays: 30, tags: [] },
    { id: "vm-00000002", name: "web-recette-01", host: "", env: "recette", description: "", lastPatch: "2026-10-01", nextPatch: "2026-12-20", everyDays: null, tags: [] }
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
    assert.match(parc, /`app-prod-01` \(production\) : \*\*patch en retard de 2 j\*\*$/m);
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
