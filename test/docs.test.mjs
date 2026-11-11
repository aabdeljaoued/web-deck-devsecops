// Documentation « Doc as Code » (docs/) : liens et images vérifiés à chaque `npm test` et dans la CI.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs");
const pages = readdirSync(DOCS).filter((f) => f.endsWith(".md"));
const read = (f) => readFileSync(path.join(DOCS, f), "utf8");
/** Cibles des liens et images Markdown ([texte](cible) et ![alt](cible)), hors code. */
const targets = (md) => [...md.replace(/```[\s\S]*?```/g, "").matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => ({ image: m[0].startsWith("!"), target: m[1] }));

test("docs : chaque lien local et chaque image existent", () => {
    const broken = [];
    for (const page of pages) {
        for (const { target } of targets(read(page))) {
            if (/^(https?:|mailto:|#)/.test(target)) continue;
            const file = decodeURIComponent(target.split("#")[0]);
            if (!existsSync(path.resolve(DOCS, file))) broken.push(`${page} → ${target}`);
        }
    }
    assert.deepEqual(broken, []);
});

test("docs : aucune image orpheline, images dans img/ uniquement", () => {
    const used = new Set();
    for (const page of pages) {
        for (const { image, target } of targets(read(page))) {
            if (!image) continue;
            assert.match(target, /^img\/[\w.-]+\.(jpe?g|png|svg|gif)$/, `${page} : image hors de img/ ou nom invalide (${target})`);
            used.add(target.slice(4));
        }
    }
    const orphans = readdirSync(path.join(DOCS, "img")).filter((f) => !used.has(f));
    assert.deepEqual(orphans, [], "images de docs/img non utilisées");
});

test("docs : chaque page figure au sommaire et y renvoie", () => {
    const summary = read("README.md");
    for (const page of pages.filter((p) => p !== "README.md")) {
        assert.ok(summary.includes(`](${page})`), `${page} absente du sommaire`);
        assert.ok(read(page).includes("](README.md)"), `${page} ne renvoie pas au sommaire`);
        assert.match(read(page), /^# /, `${page} : titre de niveau 1 attendu en première ligne`);
    }
});
