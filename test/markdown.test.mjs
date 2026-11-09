import assert from "node:assert/strict";
import { test } from "node:test";

import { parse, toAnsi, toHtml } from "../public/markdown.js";

const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("terminal : lignes de code sans décor (sélection propre), titre et fin de note", () => {
    const out = plain(toAnsi("# Titre\n```bash\nkubectl get pods -n monitoring\n```", "Ma note", 60)).split("\r\n");
    assert.ok(out.some((l) => l === "  kubectl get pods -n monitoring"), "commande en retrait, sans caractère ajouté");
    assert.match(out[1], /Note : Ma note/);
    assert.match(out.at(-2), /fin de la note/);
});

test("terminal : séquences de contrôle de la note neutralisées", () => {
    const out = toAnsi("texte \x1b]0;titre-piege\x07 \x1b[2J fin \x9b31m");
    assert.ok(!/\x1b(?!\[[0-9;]*m)/.test(out), "seules les couleurs du rendu restent");
    assert.ok(!out.includes("\x07") && !out.includes("\x9b"));
});

test("code en ligne protégé : un « * » n'est pas de l'italique", () => {
    assert.equal(plain(toAnsi("faire `rm -rf *.tmp` puis *ok*")).split("\r\n")[2], "faire rm -rf *.tmp puis ok");
    assert.match(toHtml("`a * b` et *c*"), /<code>a \* b<\/code> et <em>c<\/em>/);
});

test("aperçu HTML : texte échappé, liens http(s) seulement", () => {
    const html = toHtml("<script>alert(1)</script> [ok](https://ok.fr) [ko](javascript:alert(1))");
    assert.ok(!html.includes("<script>"));
    assert.match(html, /href="https:\/\/ok\.fr\/?"/);
    assert.ok(!/href="javascript/.test(html));
});

test("analyse : listes, cases à cocher, tableaux, citations", () => {
    const types = parse("- [x] fait\n1. un\n> cite\n| a | b |\n|---|---|\n| 1 | 2 |\n---").map((b) => b.type);
    assert.deepEqual(types, ["item", "item", "quote", "table", "hr"]);
    assert.equal(parse("- [x] fait")[0].task, true);
    assert.deepEqual(parse("| a | b |\n|---|---|\n| 1 | 2 |")[0].rows, [["a", "b"], ["1", "2"]]);
});

test("aperçu : une ligne de code par élément (cliquable), texte du bloc inchangé", () => {
    const html = toHtml("```bash\nkubectl get pods\nkubectl get svc\n```");
    assert.equal((html.match(/class="md-code-line"/g) ?? []).length, 2);
    assert.match(html, /<span class="md-code-line">kubectl get pods<\/span>\n<span class="md-code-line">kubectl get svc<\/span>/);
});
