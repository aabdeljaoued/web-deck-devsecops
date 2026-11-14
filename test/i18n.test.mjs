import { test } from "node:test";
import assert from "node:assert/strict";
import { compile, translate } from "../public/i18n-core.js";
import EN from "../public/i18n/en.js";

const C = compile(EN);
const placeholders = (s) => [...s.matchAll(/\{(\d)(?::[^}]*)?\}/g)].map((m) => m[1]).sort().join(",");

test("dictionnaire : valeurs non vides, mêmes variables en français et en anglais", () => {
    for (const [fr, en] of Object.entries(EN)) {
        assert.ok(typeof en === "string" && en.trim(), `traduction vide : ${fr}`);
        assert.equal([...new Set(placeholders(en).split(","))].sort().join(","), [...new Set(placeholders(fr).split(","))].sort().join(","), `variables : ${fr}`);
    }
});

test("traduction exacte, espaces de bord gardés, texte inconnu inchangé", () => {
    assert.equal(translate(C, "Réglages"), "Settings");
    assert.equal(translate(C, "  Annuler\n"), "  Cancel\n");
    assert.equal(translate(C, "texte absent du dictionnaire"), "texte absent du dictionnaire");
    assert.equal(translate(C, ""), "");
});

test("modèles : variables, pluriels, valeurs elles-mêmes traduites", () => {
    assert.equal(translate(C, "1 VM(s)"), "1 VM");
    assert.equal(translate(C, "12 VM(s)"), "12 VMs");
    assert.equal(translate(C, "dans 3 j"), "in 3 d");
    assert.equal(translate(C, "Trier par : Prochain patch"), "Sort by: Next patch");
    assert.equal(translate(C, "Modifier « app-prod-01 »"), "Edit \"app-prod-01\"");
});

test("textes sur plusieurs lignes : infobulle, texte HTML coupé, ligne par ligne", () => {
    assert.equal(translate(C, "Connexion directe · ok\nClic : changer de mode"), "Direct connection · ok\nClick: change mode");
    assert.equal(translate(C, "Tableau de bord\n            des patchs"), "Patch dashboard");
    assert.equal(translate(C, "app-01 : à planifier\napp-02 : dans 3 j (17/11/2026)"), "app-01: to schedule\napp-02: in 3 d (17/11/2026)");
});
