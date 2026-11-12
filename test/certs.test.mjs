import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";

import { readFileSync } from "node:fs";
import tls from "node:tls";

import { checkCert, isInterception, proxyFor, resetRoutes } from "../server/certs.mjs";

test("proxy : HTTPS_PROXY / https_proxy, port par défaut, identifiants", () => {
    assert.equal(proxyFor("a.test", 443, {}), null);
    assert.deepEqual(proxyFor("a.test", 443, { HTTPS_PROXY: "http://proxy.corp:8080" }), { host: "proxy.corp", port: 8080, tls: false, auth: null, label: "proxy.corp:8080" });
    assert.equal(proxyFor("a.test", 443, { https_proxy: "proxy.corp" }).port, 8080);
    assert.equal(proxyFor("a.test", 443, { HTTPS_PROXY: "http://u%40x:p%3Aw@proxy.corp:3128" }).auth, "u@x:p:w");
    assert.throws(() => proxyFor("a.test", 443, { HTTPS_PROXY: "socks5://proxy:1080" }), /non pris en charge/);
});

test("NO_PROXY : *, domaine et sous-domaines, port précisé", () => {
    const env = (no) => ({ HTTPS_PROXY: "http://p:8080", NO_PROXY: no });
    assert.equal(proxyFor("x.test", 443, env("*")), null);
    assert.equal(proxyFor("api.interne.test", 443, env("localhost, .interne.test")), null);
    assert.equal(proxyFor("interne.test", 443, env("interne.test")), null);
    assert.notEqual(proxyFor("autre.test", 443, env("interne.test")), null);
    assert.notEqual(proxyFor("pasinterne.test", 443, env("interne.test")), null, "suffixe sans point : pas couvert");
    assert.equal(proxyFor("ldap.corp", 636, env("ldap.corp:636")), null);
    assert.notEqual(proxyFor("ldap.corp", 443, env("ldap.corp:636")), null);
});

test("interception : émetteurs des proxys qui déchiffrent le TLS", () => {
    assert.ok(isInterception("Zscaler Intermediate Root CA (zscaler.net)"));
    assert.ok(isInterception("Netskope Inc"));
    assert.ok(!isInterception("GlobalSign GCC R3 EV TLS CA 2025 · GlobalSign nv-sa"));
});

/** Proxy de test qui répond toujours `status` à la demande CONNECT. */
async function refusingProxy(status) {
    const seen = [];
    const server = net.createServer((c) => c.once("data", (b) => { seen.push(b.toString("latin1")); c.end(`HTTP/1.1 ${status} Non\r\n\r\n`); }));
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    return { server, seen, env: { HTTPS_PROXY: `http://user:secret@127.0.0.1:${server.address().port}` } };
}

test("proxy qui refuse : raison claire (403, 407, 502), demande CONNECT avec authentification", async () => {
    for (const [status, why] of [[403, /refuse cette destination/], [407, /authentification du proxy/], [502, /n'atteint pas l'hôte \(502\)/]]) {
        const p = await refusingProxy(status);
        await assert.rejects(checkCert("site.example.test", 443, { env: p.env, timeout: 3000 }), why);
        assert.match(p.seen[0], /^CONNECT site\.example\.test:443 HTTP\/1\.1\r\nHost: site\.example\.test:443\r\nProxy-Authorization: Basic dXNlcjpzZWNyZXQ=\r\n\r\n$/);
        p.server.close();
    }
});

test("proxy qui n'atteint pas un hôte interne : repli en direct, chemin retenu ensuite", async () => {
    // Serveur TLS local (certificat de test auto-signé, fixtures) joignable seulement en direct
    const fixture = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url));
    const server = tls.createServer({ cert: fixture("tls-test-cert.pem"), key: fixture("tls-test-key.pem") }, (c) => c.end());
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const p = await refusingProxy(502);
    resetRoutes();
    try {
        const port = server.address().port;
        const first = await checkCert("127.0.0.1", port, { env: p.env, timeout: 3000 });
        assert.equal(first.direct, true);
        assert.equal(first.subject, "deck-test.local");
        assert.equal(first.trusted, false, "auto-signé : chaîne non reconnue, mais date lue");
        assert.equal(p.seen.length, 1, "le proxy a été essayé d'abord");
        await checkCert("127.0.0.1", port, { env: p.env, timeout: 3000 });
        assert.equal(p.seen.length, 1, "2e vérification : directement en direct, sans repasser par le proxy");
        // Ni le proxy ni le direct : les deux raisons
        await assert.rejects(checkCert("127.0.0.1", 1, { env: p.env, timeout: 3000 }), /par le proxy : le proxy n'atteint pas l'hôte \(502\) ; en direct : /);
    } finally {
        server.close();
        p.server.close();
        resetRoutes();
    }
});

test("proxy éteint : « proxy injoignable », pas confondu avec le site", async () => {
    await assert.rejects(checkCert("site.example.test", 443, { env: { HTTPS_PROXY: "http://127.0.0.1:1" }, timeout: 3000 }), /proxy injoignable/);
});

test("nom court du voyant : www retiré, adresse IP gardée, nom long raccourci", async () => {
    const { shortHost } = await import("../server/status.mjs");
    assert.equal(shortHost("www.lecode.laposte.fr"), "lecode");
    assert.equal(shortHost("www2.exemple.fr:8443"), "exemple");
    assert.equal(shortHost("proxmox.aabdeljaoued.synology.me"), "proxmox");
    assert.equal(shortHost("10.0.0.5:443"), "10.0.0.5");
    assert.equal(shortHost("devsecops-production.client.fr"), "devseco…");
    assert.equal(shortHost("www.wikipedia.org"), "wikiped…", "8 caractères au plus : une ligne sur la touche");
});

test("niveau d'un certificat selon l'environnement : production 30 / 7 j, hors production 14 / 3 j", async () => {
    const { certLevel } = await import("../server/status.mjs");
    assert.deepEqual([45, 20, 5, -1].map((d) => certLevel("production", d)), ["ok", "orange", "rouge", "rouge"]);
    assert.deepEqual([20, 10, 2, -1].map((d) => certLevel("recette", d)), ["ok", "orange", "rouge", "rouge"]);
});

test("alertes certificats : production orange puis rouge ; hors production seulement au rouge", async () => {
    const { StatusHub } = await import("../server/status.mjs");
    const { tmpDir } = await import("./helpers.mjs");
    const path = (await import("node:path")).default;
    const hub = new StatusHub({ cfg: {}, apps: {}, containerCli: ["docker"] });
    hub.alertFile = path.join(tmpDir(), "alerts.json");
    const got = [];
    hub.on("cert-alert", (a) => got.push(a.map((x) => `${x.target}:${x.level}`).join(",")));
    const cert = (target, env, days) => ({ target, env, days, validTo: new Date(Date.now() + days * 86400e3) });
    hub.checkCertAlerts([cert("api.prod.test", "production", 20), cert("api.rec.test", "recette", 10)]);
    hub.checkCertAlerts([cert("api.prod.test", "production", 20), cert("api.rec.test", "recette", 2)]);
    assert.deepEqual(got, ["api.prod.test:orange", "api.rec.test:rouge"], "recette à 10 j : pas d'alerte ; à 2 j : rouge");
});
