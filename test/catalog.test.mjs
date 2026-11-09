import assert from "node:assert/strict";
import { test } from "node:test";

import { buildDeck } from "../server/catalog.mjs";
import { loadConfig } from "../server/config.mjs";

const ctx = loadConfig();
const keys = (deck) => Object.entries(deck.pages).flatMap(([page, list]) => list.filter(Boolean).map((k) => ({ page, ...k })));

test("le deck de config.jsonc tient sur l'accueil (18 touches au plus)", () => {
    const deck = buildDeck(ctx, []);
    assert.ok(deck.pages.root.filter(Boolean).length <= 18);
    assert.ok(deck.pages.root.some((k) => k?.type === "clear"), "clear sur l'accueil");
});

test("rubriques des Réglages : désactiver, ajouter, refus au-delà de 18", () => {
    const deck = buildDeck(ctx, [], { brew: false, sec: true });
    const roots = deck.pages.root.filter(Boolean).map((k) => k.page);
    assert.ok(!roots.includes("brew") && roots.includes("sec"));
    assert.ok(!deck.pages.brew, "rubrique désactivée : plus de page (ni de palette)");
    const all = Object.fromEntries(deck.worlds.list.map((w) => [w.id, true]));
    assert.throws(() => buildDeck(ctx, [], all), /max 18/);
});

test("chaque touche du catalogue a une description (infobulle)", () => {
    for (const worlds of [{ sec: true, vault: true, brew: false, ansible: false }, { ansible: true, brew: true, k8s: false, docker: false, helm: false, terraform: false }]) {
        const missing = keys(buildDeck(ctx, [], worlds)).filter((k) => ["text", "run", "web"].includes(k.type) && !k.desc && !k.page.startsWith("fav"));
        assert.deepEqual(missing.map((k) => `${k.page}/${k.label}`), []);
    }
});

test("garde-fou production sur les touches qui agissent sur le cluster", () => {
    const guarded = keys(buildDeck(ctx, [])).filter((k) => k.prodGuard).map((k) => `${k.page}/${k.label}`).sort();
    assert.deepEqual(guarded, ["helm/rollback", "helm/uninstall", "helm/upgrade -i", "k8s/exec -it"]);
});

test("Ansible : touches marquées unix ; la commande des touches run n'est pas envoyée au navigateur", () => {
    const all = keys(buildDeck(ctx, [], { ansible: true }));
    assert.ok(all.filter((k) => k.page === "ansible" && k.type === "text").every((k) => k.unix));
    assert.ok(all.filter((k) => k.type === "run").every((k) => !("command" in k)));
});

test("ordre des rubriques des Réglages : respecté, identifiants inconnus ignorés, les autres à la suite", () => {
    const deck = buildDeck(ctx, [], {}, ["favoris", "linux", "inconnu"]);
    const roots = deck.pages.root.filter((k) => k?.type === "folder").map((k) => k.page);
    assert.deepEqual(roots.slice(0, 2), ["favoris", "linux"]);
    assert.equal(new Set(roots).size, roots.length, "aucune rubrique en double");
    assert.deepEqual(buildDeck(ctx, []).worlds.defaultOrder.slice(0, 2), (ctx.cfg.sections ?? []).slice(0, 2));
});

test("touches à compléter K8s / Docker : variante à liste réelle (paramètres connus seulement)", async () => {
    const { liveParam } = await import("../server/params.mjs");
    const all = keys(buildDeck(ctx, [], { k8s: true, docker: true }));
    const picks = all.filter((k) => k.pick);
    for (const label of ["logs -f", "describe", "exec -it", "inspect"]) assert.ok(picks.some((k) => k.label === label), label);
    for (const k of picks) {
        assert.equal(k.type, "text");
        const params = [...k.pick.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
        assert.ok(params.length && params.every((p) => liveParam(p)), `${k.label} : ${k.pick}`);
    }
    assert.ok(picks.find((k) => k.label === "exec -it" && k.pick.startsWith("kubectl"))?.prodGuard, "garde-fou production conservé");
});
