import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { Vault } from "../server/vault.mjs";
import { tmpDir } from "./helpers.mjs";

const pw = () => randomBytes(12).toString("hex");   // mots de passe de test générés

test("création, notes (avec couleur) et secrets chiffrés, rien en clair sur disque", async () => {
    const v = new Vault(path.join(tmpDir(), "vault.enc"));
    await v.create(pw());
    const id = v.saveNote({ title: "Note confidentielle", body: "corps", color: "#e53935" });
    v.saveSecret({ name: "token-ci", value: "valeur-tres-secrete" });
    const raw = readFileSync(v.file, "utf8");
    for (const clear of ["Note confidentielle", "valeur-tres-secrete", "#e53935"]) assert.ok(!raw.includes(clear), `${clear} en clair`);
    assert.equal(v.view().notes[0].color, "#e53935");
    assert.equal(v.view().secrets[0].value, undefined, "la vue n'expose pas la valeur");
    assert.throws(() => v.saveNote({ id, title: "x", body: "", color: "rouge" }), /couleur/);
    v.lock();
});

test("déverrouillage : mauvais mot de passe refusé, bon accepté, contenu retrouvé", async () => {
    const password = pw();
    const file = path.join(tmpDir(), "vault.enc");
    const v = new Vault(file);
    await v.create(password);
    v.saveNote({ title: "N", body: "B", color: "#43a047" });
    v.lock();
    const w = new Vault(file);
    await assert.rejects(w.unlock("mauvais"), /incorrect/);
    w.failures = 0;   // pas d'attente de pénalité dans le test
    await w.unlock(password);
    assert.equal(w.view().notes[0].color, "#43a047");
    w.lock();
    assert.equal(w.unlocked, false);
});

test("export / import : export toujours chiffré, fusion, remplacement avec .bak", async () => {
    const dir = tmpDir();
    const pa = pw();
    const pb = pw();
    const a = new Vault(path.join(dir, "a.enc"));
    await a.create(pa);
    a.saveNote({ title: "Note A", body: "" });
    a.saveSecret({ name: "s", value: "secret-a" });
    const exp = JSON.parse(JSON.stringify(a.exportBox()));
    assert.ok(!JSON.stringify(exp).includes("secret-a"));

    const b = new Vault(path.join(dir, "b.enc"));
    await b.create(pb);
    b.saveNote({ title: "Note B", body: "" });
    await assert.rejects(b.importBox(exp, "merge", "mauvais"), /incorrect/);
    b.failures = 0;
    assert.equal((await b.importBox(exp, "merge", pa)).added, 2);
    assert.equal((await b.importBox(exp, "merge", pa)).added, 0, "deuxième fusion : rien en double");
    await b.importBox(exp, "replace", pa);
    assert.ok(existsSync(path.join(dir, "b.enc.bak")));
    assert.deepEqual(b.view().notes.map((n) => n.title), ["Note A"]);

    const c = new Vault(path.join(dir, "c.enc"));
    await c.importBox(exp, "use", pa);
    assert.equal(c.secretValue(c.view().secrets[0].id), "secret-a");
    for (const x of [a, b, c]) x.lock();
});
