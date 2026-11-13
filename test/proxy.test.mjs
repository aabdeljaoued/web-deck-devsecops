import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanNoProxy, cleanProxyUrl, ProxyManager, proxyEnv } from "../server/proxy.mjs";

test("adresse du proxy : http:// ajouté, port gardé, identifiants refusés", () => {
    assert.equal(cleanProxyUrl(""), "");
    assert.equal(cleanProxyUrl("scc.proxy.intra.client.test:8080"), "http://scc.proxy.intra.client.test:8080");
    assert.equal(cleanProxyUrl("https://proxy.test"), "https://proxy.test");
    assert.throws(() => cleanProxyUrl("http://user:pass@proxy.test:8080"), /identifiants/);
    assert.throws(() => cleanProxyUrl("socks5://proxy.test:1080"), /http/);
});

test("NO_PROXY : virgules ou espaces, minuscules, sans doublon, caractères contrôlés", () => {
    assert.equal(cleanNoProxy("GitLab.net.extra.client.test  .intra.client.test,localhost, localhost"), "gitlab.net.extra.client.test,.intra.client.test,localhost");
    assert.throws(() => cleanNoProxy("a;b c$(id)"), /invalide/);
});

test("variables : les 6 (majuscules et minuscules) pour un proxy actif, toutes retirées sinon", () => {
    assert.deepEqual(proxyEnv({ url: "http://p:8080", noProxy: "localhost" }), { HTTPS_PROXY: "http://p:8080", https_proxy: "http://p:8080", HTTP_PROXY: "http://p:8080", http_proxy: "http://p:8080", NO_PROXY: "localhost", no_proxy: "localhost" });
    assert.ok(Object.values(proxyEnv(null)).every((v) => v === undefined));
});

test("modes : système (variables d'origine), désactivé, activé, automatique bureau / maison ; options git", async () => {
    const env = { HTTPS_PROXY: "http://proxy.bureau.test:8080", NO_PROXY: ".intra.test", PATH: "/bin" };
    let settings = { mode: "system", url: "", noProxy: "" };
    let reachable = true;
    const m = new ProxyManager(() => settings, { env, probe: async () => reachable });
    const changes = [];
    m.on("change", (s) => changes.push(`${s.mode}:${s.active}`));

    await m.start();
    clearInterval(m.timer);
    assert.equal(env.HTTPS_PROXY, "http://proxy.bureau.test:8080");
    assert.deepEqual(m.gitArgs(), [], "système : git garde sa propre configuration");

    settings = { ...settings, mode: "off" };
    await m.refresh();
    assert.equal(env.HTTPS_PROXY, undefined);
    assert.equal(env.https_proxy, undefined);
    assert.equal(env.PATH, "/bin", "les autres variables ne bougent pas");
    assert.deepEqual(m.gitArgs(), ["-c", "http.proxy=", "-c", "https.proxy="], "désactivé : un http.proxy de git est neutralisé");

    settings = { mode: "on", url: "", noProxy: "" };
    await m.refresh();
    assert.equal(env.https_proxy, "http://proxy.bureau.test:8080", "activé sans adresse : celle des variables d'origine");
    assert.equal(env.NO_PROXY, ".intra.test");

    settings = { mode: "auto", url: "http://autre.proxy.test:3128", noProxy: "localhost" };
    reachable = false;   // à la maison
    await m.refresh();
    assert.equal(m.state.active, false);
    assert.equal(env.HTTPS_PROXY, undefined);
    reachable = true;    // au bureau
    await m.refresh();
    assert.equal(env.HTTPS_PROXY, "http://autre.proxy.test:3128");
    assert.equal(env.no_proxy, "localhost");
    assert.deepEqual(m.gitArgs(), ["-c", "http.proxy=http://autre.proxy.test:3128", "-c", "https.proxy=http://autre.proxy.test:3128"]);
    await m.refresh();   // rien de changé : pas d'événement

    settings = { mode: "system", url: "", noProxy: "" };
    await m.refresh();
    assert.equal(env.HTTPS_PROXY, "http://proxy.bureau.test:8080", "retour exact aux variables d'origine");
    assert.equal(env.https_proxy, undefined, "variable absente au départ : de nouveau absente");
    assert.deepEqual(changes, ["system:true", "off:false", "on:true", "auto:false", "auto:true", "system:true"]);
});
