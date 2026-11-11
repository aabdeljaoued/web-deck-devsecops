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

test("missions : validation (nom, motif de production, doublons), mission active", () => {
    const s = new Settings(path.join(tmpDir(), "settings.json"));
    const bnp = { id: "m-bnp", name: "BNP", theme: "bnp", prodPattern: "prd|prod", worlds: { brew: false }, worldOrder: ["k8s"], workspace: "/tmp", favGroup: "" };
    const saved = s.update({ missions: [bnp], activeMission: "m-bnp" });
    assert.equal(saved.missions[0].name, "BNP");
    assert.equal(saved.activeMission, "m-bnp");
    assert.throws(() => s.update({ missions: [{ ...bnp, name: " " }] }), /nom/);
    assert.throws(() => s.update({ missions: [{ ...bnp, prodPattern: "prod(" }] }), /motif/);
    assert.throws(() => s.update({ missions: [bnp, bnp] }), /double/);
    assert.throws(() => s.update({ missions: [{ ...bnp, theme: "acme" }] }), /thème/);
    assert.equal(s.update({ missions: [{ ...bnp, favGroup: "../x" }] }).missions[0].favGroup, "", "groupe de favoris invalide ignoré");
});

test("journal : activé par défaut, désactivable", () => {
    const s = new Settings(path.join(tmpDir(), "settings.json"));
    assert.equal(s.get().journalEnabled, true);
    assert.equal(s.update({ journalEnabled: false }).journalEnabled, false);
    assert.throws(() => s.update({ journalEnabled: "non" }), /journal/);
});

test("signature en bannière ASCII : style et police validés, bannière dessinée", async () => {
    const s = new Settings(path.join(tmpDir(), "settings.json"));
    assert.equal(s.get().watermarkStyle, "text");
    assert.equal(s.update({ watermarkStyle: "ascii", watermarkFont: "Slant" }).watermarkFont, "Slant");
    assert.throws(() => s.update({ watermarkFont: "Comic Sans" }), /police/);
    const { default: figlet } = await import("figlet");
    for (const font of ["ANSI Shadow", "Standard", "Slant", "Big", "Small", "Doom", "Banner3", "Block"]) {
        assert.ok(figlet.textSync("Ab", { font }).split("\n").length >= 3, `police ${font}`);
    }
});

test("variables de mission : noms et valeurs vérifiés, gardées à l'enregistrement", () => {
    const s = new Settings(path.join(tmpDir(), "settings.json"));
    const m = (vars) => ({ missions: [{ id: "m-1", name: "Client", vars }] });
    s.update(m({ registry: " harbor.client.test ", ns: "app" }));
    assert.deepEqual(s.get().missions[0].vars, { registry: "harbor.client.test", ns: "app" });
    assert.throws(() => s.update(m({ "1abc": "x" })), /nom de variable invalide/);
    assert.throws(() => s.update(m({ cmd: "ls\nrm" })), /une ligne/);
    assert.throws(() => s.update(m(["x"])), /variables invalides/);
    assert.deepEqual(new Settings(path.join(tmpDir(), "s2.json")).get().missions, []);
});

test("certificats d'une mission : hôte ou hôte:port et environnement, minuscules, sans doublon", () => {
    const s = new Settings(path.join(tmpDir(), "settings.json"));
    const m = (certs) => ({ missions: [{ id: "m-1", name: "Client", certs }] });
    // Ancien format (texte seul) : production par défaut ; doublons retirés
    s.update(m(["API.client.test", { target: "ldap.client.test:636", env: "rec" }, "api.client.test", { target: "dev.client.test", env: "dev" }]));
    assert.deepEqual(s.get().missions[0].certs, [
        { target: "api.client.test", env: "production" },
        { target: "ldap.client.test:636", env: "recette" },
        { target: "dev.client.test", env: "développement" }
    ]);
    assert.throws(() => s.update(m([{ target: "x.test", env: "bac-a-sable" }])), /environnement inconnu/);
    assert.throws(() => s.update(m(["https://x.test"])), /invalide/);
    assert.throws(() => s.update(m(["x.test:70000"])), /port invalide/);
    assert.throws(() => s.update(m(["a.test; rm -rf /"])), /invalide/);
});
