// Documentation « Doc as Code » (docs/, version anglaise dans docs/en/) : liens et images vérifiés à chaque `npm test`
// et dans la CI.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs");
const EN = path.join(DOCS, "en");
const list = (dir) => readdirSync(dir).filter((f) => f.endsWith(".md"));
const pages = list(DOCS);
const pagesEn = list(EN);
/** Les deux versions : dossier, pages, préfixe attendu des images (partagées dans docs/img). */
const VERSIONS = [
    { name: "docs", dir: DOCS, pages, img: "img/" },
    { name: "docs/en", dir: EN, pages: pagesEn, img: "../img/" }
];
const read = (dir, f) => readFileSync(path.join(dir, f), "utf8");
/** Cibles des liens et images Markdown ([texte](cible) et ![alt](cible)), hors code. */
const targets = (md) => [...md.replace(/```[\s\S]*?```/g, "").matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => ({ image: m[0].startsWith("!"), target: m[1] }));

test("docs : chaque lien local et chaque image existent (français et anglais)", () => {
    const broken = [];
    for (const v of VERSIONS) {
        for (const page of v.pages) {
            for (const { target } of targets(read(v.dir, page))) {
                if (/^(https?:|mailto:|#)/.test(target)) continue;
                const file = decodeURIComponent(target.split("#")[0]);
                if (!existsSync(path.resolve(v.dir, file))) broken.push(`${v.name}/${page} → ${target}`);
            }
        }
    }
    assert.deepEqual(broken, []);
});

test("docs : aucune image orpheline, images dans docs/img uniquement", () => {
    const used = new Set();
    for (const v of VERSIONS) {
        for (const page of v.pages) {
            for (const { image, target } of targets(read(v.dir, page))) {
                if (!image) continue;
                assert.ok(target.startsWith(v.img), `${v.name}/${page} : image hors de docs/img (${target})`);
                const name = target.slice(v.img.length);
                assert.match(name, /^[\w.-]+\.(jpe?g|png|svg|gif)$/, `${v.name}/${page} : nom d'image invalide (${target})`);
                used.add(name);
            }
        }
    }
    const orphans = readdirSync(path.join(DOCS, "img")).filter((f) => !used.has(f));
    assert.deepEqual(orphans, [], "images de docs/img non utilisées");
});

test("docs : chaque page figure au sommaire et y renvoie (français et anglais)", () => {
    for (const v of VERSIONS) {
        const summary = read(v.dir, "README.md");
        for (const page of v.pages.filter((p) => p !== "README.md")) {
            assert.ok(summary.includes(`](${page})`), `${v.name}/${page} absente du sommaire`);
            assert.ok(read(v.dir, page).includes("](README.md)"), `${v.name}/${page} ne renvoie pas au sommaire`);
            assert.match(read(v.dir, page), /^# /, `${v.name}/${page} : titre de niveau 1 attendu en première ligne`);
        }
    }
});

test("docs : chaque page française a sa version anglaise, mêmes noms de fichiers", () => {
    assert.deepEqual([...pagesEn].sort(), [...pages].sort());
});

test("docs : la version anglaise montre les mêmes captures", () => {
    const images = (dir, page, prefix) => targets(read(dir, page)).filter((t) => t.image).map((t) => t.target.slice(prefix.length));
    for (const page of pages) {
        const en = new Set(images(EN, page, "../img/"));
        for (const n of images(DOCS, page, "img/")) assert.ok(en.has(n), `en/${page} : capture ${n} absente`);
    }
});
