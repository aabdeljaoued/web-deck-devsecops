// Relevé patch : ligne repère imprimée sur la VM, lue dans la sortie du terminal, qui met la VM à jour.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { addDays, parseSurvey, Patches, SURVEY_LINE, today, vmLevel } from "../server/patches.mjs";
import { tmpDir } from "./helpers.mjs";

const NOW = new Date();
const line = (o = {}) => `DECK-PATCH host=${o.host ?? "mysql-rec-01"} os=${o.os ?? "rocky9.4"} last=${o.last ?? "2026-11-10"} pending=${o.pending ?? "12"} security=${o.security ?? "3"} reboot=${o.reboot ?? "yes"}\r\n`;

test("ligne repère : lue, valeurs vérifiées ; ligne incomplète ou écho de la commande ignorés", () => {
    const c = parseSurvey(`bla\r\n${line()}$ `, NOW);
    assert.deepEqual({ ...c, at: undefined }, { at: undefined, host: "mysql-rec-01", os: "rocky9.4", last: "2026-11-10", pending: 12, security: 3, reboot: true });
    assert.equal(parseSurvey(line().trimEnd()), null, "sans fin de ligne : la suite n'est pas encore arrivée");
    // Valeurs absentes (Windows : pas de compte des MAJ) ou douteuses
    const w = parseSurvey(line({ os: "windows", pending: "", security: "", reboot: "no", last: "pas-une-date" }));
    assert.equal(w.pending, null);
    assert.equal(w.security, null);
    assert.equal(w.last, "");
    assert.equal(w.reboot, false);
    // La commande de la touche imprime « DECK-%s … PATCH » : son texte ne contient jamais la ligne repère
    const catalog = readFileSync(new URL("../server/catalog.mjs", import.meta.url), "utf8");
    const cmd = /textIcon\("relevé patch", "✓", ("(?:[^"\\]|\\.)*")/.exec(catalog)[1];
    assert.ok(!JSON.parse(cmd).includes("DECK-PATCH"));
    assert.ok(!SURVEY_LINE.test(`${JSON.parse(cmd)}\n`));
});

test("niveau d'une VM : mises à jour de sécurité en attente = orange, même avec une date lointaine", () => {
    const vm = { name: "a", nextPatch: addDays(today(), 30) };
    assert.equal(vmLevel(vm), "ok");
    assert.equal(vmLevel({ ...vm, check: { security: 2 } }), "orange");
    assert.equal(vmLevel({ ...vm, check: { security: 0, reboot: true } }), "ok", "redémarrage requis : affiché, sans changer le niveau");
    assert.equal(vmLevel({ ...vm, nextPatch: addDays(today(), -1), check: { security: 2 } }), "rouge", "le retard reste rouge");
    assert.equal(vmLevel({ ...vm, decommissioned: true, check: { security: 2 } }), "ok", "décommissionnée : hors suivi");
});

test("relevé appliqué : dernier patch lu sur la VM, prochain recalculé ; relevé gardé après Modifier", () => {
    const file = path.join(tmpDir(), "patches.json");
    const p = new Patches(file);
    const id = p.save({ name: "mysql-rec-01", env: "recette", lastPatch: "2026-09-01", everyDays: 30 });
    const last = addDays(today(), -5);
    const { vm, lastChanged } = p.applySurvey("mysql-rec-01", parseSurvey(line({ last })));
    assert.equal(lastChanged, "2026-09-01");
    assert.equal(vm.lastPatch, last);
    assert.equal(vm.nextPatch, addDays(last, 30));
    assert.equal(vm.check.security, 3);
    // Date dans le futur (horloge de la VM décalée) : relevé gardé, dates inchangées
    const future = p.applySurvey("mysql-rec-01", parseSurvey(line({ last: addDays(today(), 3) })));
    assert.equal(future.lastChanged, null);
    assert.equal(future.vm.lastPatch, last);
    // Modifier (le formulaire n'envoie pas le relevé) puis recharger : relevé conservé
    p.save({ id, name: "mysql-rec-01", env: "recette", lastPatch: last, everyDays: 30, description: "nœud 1" });
    const again = new Patches(file).list()[0];
    assert.equal(again.description, "nœud 1");
    assert.equal(again.check.pending, 12);
    assert.equal(again.check.reboot, true);
    assert.throws(() => p.applySurvey("inconnue", parseSurvey(line())), /VM introuvable/);
});
