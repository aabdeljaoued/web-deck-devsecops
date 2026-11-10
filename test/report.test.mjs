import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { buildReport } from "../server/report.mjs";
import { StatusHub } from "../server/status.mjs";
import { tmpDir } from "./helpers.mjs";

const at = (h) => new Date(Date.UTC(2026, 10, 10, h, 0)).toISOString();

test("rapport : actions de la période seulement, production comptée, commandes échappées", () => {
    const md = buildReport({
        from: at(8), to: at(18), mission: "La Poste",
        entries: [
            { time: at(7), label: "hier", command: "ancienne", mode: "tapée" },
            { time: at(9), label: "pods", command: "kubectl get pods | grep api", mode: "exécutée", kube: "ctx / app", prod: false },
            { time: at(10), label: "upgrade -i", command: "helm upgrade --install api ./chart", mode: "tapée", kube: "prod-ctx / api", prod: true }
        ],
        notes: [{ title: "Runbook", done: ["kubectl get pods"] }, { title: "Vide", done: [] }]
    });
    assert.match(md, /^# Rapport d'intervention : La Poste/);
    assert.match(md, /Actions lancées depuis le deck\*\* : 2 \(dont \*\*1 en production\*\*\)/);
    assert.ok(!md.includes("ancienne"), "action hors période exclue");
    assert.match(md, /`kubectl get pods \\\| grep api`/, "barre verticale échappée dans le tableau");
    assert.match(md, /⚠ \*\*PROD\*\* prod-ctx \/ api/);
    assert.match(md, /### Runbook\n\n- \[x\] `kubectl get pods`/);
    assert.ok(!md.includes("### Vide"));
});

test("rapport : coffre verrouillé signalé, texte des sessions inclus sur demande", () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, "2026-11-10_09-00-00_zsh-1.txt"), "$ uptime\n 09:00 up 5 days\n");
    const base = { from: at(8), to: at(18), recordings: [{ name: "2026-11-10_09-00-00_zsh-1.cast", time: at(9) }], dir, notes: null };
    const sans = buildReport(base);
    assert.match(sans, /Coffre verrouillé/);
    assert.match(sans, /### 2026-11-10_09-00-00_zsh-1/);
    assert.ok(!sans.includes("up 5 days"));
    assert.match(buildReport({ ...base, withSessions: true }), /~~~text\n\$ uptime\n 09:00 up 5 days\n~~~/);
});

test("alertes certificats : une fois par seuil (orange puis rouge), oubliées après renouvellement", () => {
    const hub = new StatusHub({ cfg: {}, apps: {}, containerCli: ["docker"] });
    hub.alertFile = path.join(tmpDir(), "alerts.json");
    const got = [];
    hub.on("cert-alert", (a) => got.push(a.map((x) => `${x.target}:${x.level}`).join(",")));
    const cert = (target, days) => ({ target, days, validTo: new Date(Date.now() + days * 86400e3) });
    hub.checkCertAlerts([cert("a.test", 90), cert("b.test", 20)]);
    hub.checkCertAlerts([cert("a.test", 89), cert("b.test", 19)]);   // rien de nouveau
    hub.checkCertAlerts([cert("a.test", 88), cert("b.test", 5)]);    // b passe au rouge
    hub.checkCertAlerts([cert("a.test", 87), cert("b.test", 365)]);  // b renouvelé
    hub.checkCertAlerts([cert("a.test", 25), cert("b.test", 364)]);  // a passe à l'orange
    assert.deepEqual(got, ["b.test:orange", "b.test:rouge", "a.test:orange"]);
});
