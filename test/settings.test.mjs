import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { Settings } from "../server/settings.mjs";
import { tmpDir } from "./helpers.mjs";

test("valeurs par défaut", () => {
    const s = new Settings(path.join(tmpDir(), "settings.json")).get();
    assert.equal(s.appearance, "dark");
    assert.equal(s.autoHomeEnabled, true);
    assert.equal(s.autoHomeSeconds, 60);
    assert.deepEqual(s.worlds, {});
});

test("validation : tout ou rien, message lisible", () => {
    const s = new Settings(path.join(tmpDir(), "settings.json"));
    assert.throws(() => s.update({ appearance: "violet" }), /mode d'affichage/);
    assert.throws(() => s.update({ autoHomeSeconds: 2 }), /5 à 3600/);
    assert.throws(() => s.update({ missionTheme: "bnp", worlds: { "a b": true } }), /rubriques/);
    assert.equal(s.get().missionTheme, "", "rien n'est enregistré si une valeur est invalide");
    assert.equal(s.update({ watermark: " Nom\u0007 " }).watermark, "Nom");
});

test("ancien format : délai 0 = retour automatique désactivé", () => {
    const file = path.join(tmpDir(), "settings.json");
    writeFileSync(file, JSON.stringify({ autoHomeSeconds: 0, appearance: "nope" }));
    const s = new Settings(file).get();
    assert.equal(s.autoHomeEnabled, false);
    assert.equal(s.autoHomeSeconds, 60);
    assert.equal(s.appearance, "dark", "valeur invalide du fichier ignorée");
});

test("ordre des rubriques : liste d'identifiants, doublons retirés", () => {
    const s = new Settings(path.join(tmpDir(), "settings.json"));
    assert.deepEqual(s.update({ worldOrder: ["git", "k8s", "git"] }).worldOrder, ["git", "k8s"]);
    assert.throws(() => s.update({ worldOrder: "git" }), /ordre des rubriques/);
    assert.throws(() => s.update({ worldOrder: ["../x"] }), /ordre des rubriques/);
});
