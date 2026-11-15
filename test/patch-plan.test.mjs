import { test } from "node:test";
import assert from "node:assert/strict";
import { appKey, daysUntil, patchPlan, patchRisks, planMarkdown } from "../public/patch-plan.js";

const TODAY = new Date(2026, 10, 15);   // 15/11/2026
const vm = (name, env, nextPatch, extra = {}) => ({ name, env, nextPatch, ...extra });
const node = (name, env, nextPatch, role, cluster = "CL-MYSQL-APP-REC") => vm(name, env, nextPatch, { cluster, role, profile: "mysql-innodb" });

test("jours restants : négatif en retard, null sans date", () => {
    assert.equal(daysUntil("2026-11-18", TODAY), 3);
    assert.equal(daysUntil("2026-11-13", TODAY), -2);
    assert.equal(daysUntil("", TODAY), null);
});

test("ordre de patch : SECONDARY d'abord, bascule, ancien PRIMARY en dernier ; recette avant production", () => {
    const plan = patchPlan([
        vm("app-prod-01", "production", "2026-11-14"),
        node("mysql-rec-01", "recette", "2026-11-18", "primary"),
        node("mysql-rec-02", "recette", "2026-11-19", "secondary"),
        node("mysql-rec-03", "recette", "2026-11-17", "secondary"),
        vm("web-dev-01", "développement", "2026-12-30"),          // hors horizon
        vm("old-01", "recette", "2026-11-16", { decommissioned: true })
    ], { today: TODAY });
    assert.deepEqual(plan.map((g) => g.cluster ?? g.vms[0]), ["CL-MYSQL-APP-REC", "app-prod-01"]);
    assert.deepEqual(plan[0].steps.map((s) => (s.kind === "switch" ? `switch ${s.from}->${s.to}` : s.vm)),
        ["mysql-rec-03", "mysql-rec-02", "switch mysql-rec-01->mysql-rec-03", "mysql-rec-01"]);
    assert.equal(plan[0].steps.at(-1).note, "ancien PRIMARY");
    assert.equal(plan[1].urgency, -1);
});

test("ordre de patch : cluster sans PRIMARY signalé, rien si aucune VM due", () => {
    const plan = patchPlan([node("db-a", "recette", "2026-11-16", ""), node("db-b", "recette", "2026-11-20", "")], { today: TODAY });
    assert.match(plan[0].warning, /PRIMARY non renseigné/);
    assert.equal(plan[0].steps.some((s) => s.kind === "switch"), false);
    assert.deepEqual(patchPlan([vm("x", "recette", "2027-01-01")], { today: TODAY }), []);
});

test("plan en Markdown : étapes numérotées, commande de bascule, rappel du quorum", () => {
    const md = planMarkdown(patchPlan([node("n1", "recette", "2026-11-16", "primary"), node("n2", "recette", "2026-11-16", "secondary")], { today: TODAY }), { today: TODAY });
    assert.match(md, /^# Ordre de patch proposé \(15\/11\/2026\)/);
    assert.match(md, /1\. Patcher \*\*n2\*\* \(SECONDARY\)/);
    assert.match(md, /2\. Basculer le PRIMARY de n1 vers n2 \(`dba\.getCluster\(\)\.setPrimaryInstance\('n2'\)`\)/);
    assert.match(md, /cluster status/);
});

test("clé d'application : mots d'environnement retirés", () => {
    assert.equal(appKey("app-prod-01"), "app-01");
    assert.equal(appKey("app-rec-01"), "app-01");
    assert.equal(appKey("CL-MYSQL-APP-PROD"), "cl-mysql-app");
    assert.equal(appKey("serveur-01"), "");   // aucun mot d'environnement : pas de rapprochement
});

test("points de vigilance : même jour, quorum, PRIMARY avant SECONDARY, sans PRIMARY, sans VIP, production avant recette", () => {
    const risks = patchRisks([
        node("p1", "production", "2026-11-20", "secondary", "CL-MYSQL-APP-PROD"),
        node("p2", "production", "2026-11-20", "secondary", "CL-MYSQL-APP-PROD"),
        node("p3", "production", "2026-11-10", "primary", "CL-MYSQL-APP-PROD"),
        node("r1", "recette", "2026-11-25", "", "CL-MYSQL-APP-REC"),
        node("r2", "recette", "2026-11-12", "", "CL-MYSQL-APP-REC"),
        node("r3", "recette", "2026-11-11", "", "CL-MYSQL-APP-REC")
    ], { "CL-MYSQL-APP-PROD": { vips: [{ address: "10.0.0.10" }] } }, { today: TODAY });
    const texts = risks.map((r) => `${r.level} ${r.text}`);
    assert.ok(texts.includes("critical CL-MYSQL-APP-PROD : 2 nœuds prévus le 20/11/2026 (un nœud à la fois)"), texts.join("\n"));
    assert.ok(texts.some((t) => t.startsWith("critical CL-MYSQL-APP-REC : 2 nœuds sur 3 en retard")));
    assert.ok(texts.includes("warning CL-MYSQL-APP-PROD : le PRIMARY p3 est prévu avant ses SECONDARY (à patcher en dernier)"));
    assert.ok(texts.includes("warning CL-MYSQL-APP-REC : PRIMARY non renseigné"));
    assert.ok(texts.includes("info CL-MYSQL-APP-REC : aucune VIP renseignée"));
    assert.ok(texts.includes("warning CL-MYSQL-APP-PROD (production, le 10/11/2026) est prévu avant CL-MYSQL-APP-REC (recette, le 11/11/2026)"));
    assert.deepEqual(risks.map((r) => r.level), [...risks.map((r) => r.level)].sort((a, b) => ["critical", "warning", "info"].indexOf(a) - ["critical", "warning", "info"].indexOf(b)));
});

test("points de vigilance : rien à signaler sur un inventaire sain", () => {
    assert.deepEqual(patchRisks([
        node("a1", "recette", "2026-11-20", "secondary", "CL-A-REC"),
        node("a2", "recette", "2026-11-21", "primary", "CL-A-REC"),
        vm("app-rec-01", "recette", "2026-11-20"),
        vm("app-prod-01", "production", "2026-11-27")
    ], { "CL-A-REC": { vips: [{ address: "10.0.0.1" }] } }, { today: TODAY }), []);
});

test("relevé : la sécurité en attente fait entrer la VM dans le plan ; redémarrage requis signalé", () => {
    const vms = [vm("app-rec-01", "recette", "2027-01-15", { check: { security: 2, reboot: true } }), vm("app-rec-02", "recette", "2027-01-15")];
    assert.deepEqual(patchPlan(vms, { today: TODAY }).map((g) => g.vms[0]), ["app-rec-01"]);
    const risks = patchRisks(vms, {}, { today: TODAY });
    assert.ok(risks.some((r) => r.level === "info" && r.text === "1 VM(s) avec redémarrage requis : app-rec-01"));
});
