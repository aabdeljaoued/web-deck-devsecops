import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { Favorites, MAX_FAVORITES } from "../server/favorites.mjs";
import { tmpDir } from "./helpers.mjs";

const fresh = () => new Favorites(path.join(tmpDir(), "favoris.json"));
const labels = (items) => items.map((f) => (f.type === "group" ? `${f.label}[${labels(f.items)}]` : f.label)).join(",");

test("ajout d'un site : https ajouté, enregistré sur disque", () => {
    const f = fresh();
    f.add({ label: "Grafana", url: "grafana.example.com" });
    assert.equal(f.list()[0].url, "https://grafana.example.com/");
    assert.equal(JSON.parse(readFileSync(f.file, "utf8"))[0].label, "Grafana");
});

test("adresses refusées : autre protocole qu'http(s), adresse invalide, nom vide", () => {
    const f = fresh();
    assert.throws(() => f.add({ label: "x", url: "ftp://x" }), /http/);
    assert.throws(() => f.add({ label: "x", url: "http://" }), /invalide/);
    assert.throws(() => f.add({ label: "  ", url: "https://x.fr" }), /nom/);
});

test("groupes : deux niveaux au plus, 12 éléments par niveau", () => {
    const f = fresh();
    f.add({ kind: "group", label: "A" });
    const a = f.groups()[0].id;
    f.add({ kind: "group", label: "B", parent: a });
    const b = f.groups().find((g) => g.label === "B").id;
    assert.throws(() => f.add({ kind: "group", label: "C", parent: b }), /groupe/);
    for (let i = 0; i < MAX_FAVORITES - 1; i++) f.add({ label: `s${i}`, url: `https://s${i}.fr` });
    assert.throws(() => f.add({ label: "trop", url: "https://trop.fr" }), /12/);
});

test("glisser-déposer : réordonner, entrer dans un groupe, un groupe ne va pas en lui-même", () => {
    const f = fresh();
    f.add({ label: "A", url: "https://a.fr" });
    f.add({ label: "B", url: "https://b.fr" });
    f.add({ kind: "group", label: "G" });
    const [a, b, g] = f.items.map((x) => x.id);
    f.place(b, null, a);
    assert.equal(labels(f.list()), "B,A,G[]");
    f.place(a, g, null);
    assert.equal(labels(f.list()), "B,G[A]");
    assert.throws(() => f.place(g, g, null), /lui-même/);
});

test("import : fusion sans doublon, groupes de même nom réunis, remplacement", () => {
    const f = fresh();
    f.add({ label: "Google", url: "https://google.com" });
    f.add({ kind: "group", label: "jira" });
    const data = { kind: "favoris", favorites: [
        { label: "Google", url: "https://google.com" },
        { type: "group", label: "JIRA", items: [{ label: "Board", url: "https://jira.example.com" }] }
    ] };
    assert.deepEqual(f.import(data, "merge"), { added: 1, duplicates: 1, skipped: [] });
    assert.equal(labels(f.list()), "Google,jira[Board]");
    assert.equal(f.import(data, "merge").added, 0);
    f.import({ kind: "favoris", favorites: [{ label: "X", url: "https://x.fr" }] }, "replace");
    assert.equal(labels(f.list()), "X");
    assert.throws(() => f.import({ hello: 1 }), /non reconnu/);
});

test("import trop gros pour un niveau : refusé en entier, rien ne change", () => {
    const f = fresh();
    f.add({ label: "A", url: "https://a.fr" });
    const before = JSON.stringify(f.dump());
    const many = { kind: "favoris", favorites: Array.from({ length: 12 }, (_, i) => ({ label: `S${i}`, url: `https://s${i}.fr` })) };
    assert.throws(() => f.import(many, "merge"), /12/);
    assert.equal(JSON.stringify(f.dump()), before);
});
