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

test("action épinglée : sur l'accueil en plus de sa rubrique, comptée dans les 18 touches", () => {
    const a = fresh();
    const id = a.saveSection({ label: "Perso" });
    a.saveAction(id, { kind: "command", label: "alias", command: "alias", enter: true, pinned: true });
    const deck = buildDeck(loadConfig(), [], {}, [], a.list());
    const pinned = deck.pages.root.filter(Boolean).filter((k) => k.label === "alias");
    assert.equal(pinned.length, 1, "touche sur l'accueil alors que la rubrique n'est pas affichée");
    for (let i = 0; i < 6; i++) a.saveAction(id, { kind: "command", label: `p${i}`, command: "ls", pinned: true });
    assert.throws(() => buildDeck(loadConfig(), [], {}, [], a.list()), /max 18/);
});

test("rubrique importée : revalidée, nouveaux identifiants, rien d'épinglé, nom en double signalé", () => {
    const a = fresh();
    a.saveSection({ label: "Client" });
    const id = a.importSection({ label: "Client", icon: "lucide-star", color: "#123456", actions: [
        { label: "pods", kind: "command", command: "kubectl get pods", enter: true, pinned: true },
        { label: "doc", kind: "url", url: "docs.example.test" }
    ] });
    const s = a.section(id);
    assert.equal(s.label, "Client (importée)");
    assert.equal(s.actions.length, 2);
    assert.ok(s.actions.every((x) => /^a-[0-9a-f]{8}$/.test(x.id) && !x.pinned));
    assert.equal(s.actions[1].url, "https://docs.example.test/");
    assert.throws(() => a.importSection({ label: "X", actions: [{ label: "bad", kind: "command", command: "ls\nrm -rf /" }] }), /action 1 \(bad\).*une ligne/);
    assert.throws(() => a.importSection({ label: "X", actions: [{ label: "js", kind: "url", url: "javascript:alert(1)" }] }), /action 1/);
    assert.throws(() => a.importSection({ label: "X" }), /aucune liste/);
});
