import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { Actions, MAX_ACTIONS } from "../server/actions.mjs";
import { buildDeck } from "../server/catalog.mjs";
import { loadConfig } from "../server/config.mjs";
import { tmpDir } from "./helpers.mjs";

const fresh = () => new Actions(path.join(tmpDir(), "actions.json"));

test("rubrique et actions : création, enregistrement, relecture", () => {
    const a = fresh();
    const id = a.saveSection({ label: "Mission BNP", icon: "lucide-rocket", color: "#00965e" });
    a.saveAction(id, { kind: "command", label: "pods", command: "kubectl get pods", enter: true });
    a.saveAction(id, { kind: "command", label: "port-forward", command: "kubectl port-forward {} 8080:80", enter: true, description: "Redirige un port" });
    a.saveAction(id, { kind: "url", label: "Grafana", url: "grafana.example.com" });
    const [s] = new Actions(a.file).list();
    assert.equal(s.label, "Mission BNP");
    assert.deepEqual(s.actions.map((x) => x.label), ["pods", "port-forward", "Grafana"]);
    assert.equal(s.actions[1].enter, false, "une commande avec {} reste à compléter");
    assert.equal(s.actions[2].url, "https://grafana.example.com/");
    assert.ok(JSON.parse(readFileSync(a.file, "utf8")).sections);
});

test("refus : commande sur plusieurs lignes, lien non http, icône inconnue, nom vide", () => {
    const a = fresh();
    const id = a.saveSection({ label: "X" });
    assert.throws(() => a.saveAction(id, { kind: "command", label: "x", command: "ls\nrm -rf /" }), /une ligne/);
    assert.throws(() => a.saveAction(id, { kind: "url", label: "x", url: "javascript:alert(1)" }), /http|invalide/);
    assert.throws(() => a.saveAction(id, { kind: "url", label: "x", url: "ftp://exemple.fr" }), /http/);
    assert.throws(() => a.saveAction(id, { kind: "command", label: "x", command: "ls", icon: "lucide-nexiste-pas" }), /icône/);
    assert.throws(() => a.saveAction(id, { kind: "command", label: " ", command: "ls" }), /nom/);
    assert.throws(() => a.saveSection({ label: "Y", color: "rouge" }), /couleur/);
    for (let i = 0; i < MAX_ACTIONS; i++) a.saveAction(id, { kind: "command", label: `a${i}`, command: "ls" });
    assert.throws(() => a.saveAction(id, { kind: "command", label: "trop", command: "ls" }), /au plus/);
});

test("déplacer, modifier, supprimer", () => {
    const a = fresh();
    const id = a.saveSection({ label: "X" });
    for (const l of ["a", "b", "c"]) a.saveAction(id, { kind: "command", label: l, command: l });
    const [b] = a.list()[0].actions.slice(1, 2);
    a.moveAction(id, b.id, -1);
    assert.deepEqual(a.list()[0].actions.map((x) => x.label), ["b", "a", "c"]);
    a.saveAction(id, { id: b.id, kind: "command", label: "B", command: "echo b" });
    a.deleteAction(id, a.list()[0].actions.at(-1).id);
    assert.deepEqual(a.list()[0].actions.map((x) => `${x.label}:${x.command}`), ["B:echo b", "a:a"]);
    a.deleteSection(id);
    assert.equal(a.list().length, 0);
});

test("catalogue : une rubrique de Mes actions devient un monde de l'accueil", () => {
    const a = fresh();
    const id = a.saveSection({ label: "Perso", icon: "lucide-star", color: "#607d8b" });
    a.saveAction(id, { kind: "command", label: "alias", command: "alias", enter: true, description: "Mes alias" });
    const deck = buildDeck(loadConfig(), [], { [id]: true, brew: false }, [], a.list());
    assert.ok(deck.pages.root.some((k) => k?.page === id), "touche sur l'accueil");
    const key = deck.pages[id].find((k) => k?.label === "alias");
    assert.equal(key.desc, "Mes alias");
    assert.equal(key.text, "alias");
    assert.ok(deck.worlds.list.some((w) => w.id === id && !w.byDefault));
});
