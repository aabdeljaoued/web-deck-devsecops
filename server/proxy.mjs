// Proxy de sortie, piloté depuis l'interface (Réglages › Proxy, bouton de l'en-tête) :
// - "system" : variables d'environnement d'origine (HTTPS_PROXY, NO_PROXY…), comportement historique ;
// - "auto"   : proxy actif seulement s'il répond (bureau) ; sinon connexion directe (maison) ; testé toutes les 2 min ;
// - "on" / "off" : toujours / jamais.
// Le choix est appliqué aux variables d'environnement du serveur : tout ce qui part du deck les suit (vérification
// des certificats, git de « Mettre à jour », diagnostic, kubectl, nouveaux terminaux).
import { EventEmitter } from "node:events";
import net from "node:net";

export const PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"];
export const PROBE_EVERY_MS = 2 * 60 * 1000;

/** Proxy défini dans les variables d'environnement (au démarrage du deck). */
export function envProxy(env) {
    return {
        url: env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || "",
        noProxy: env.NO_PROXY || env.no_proxy || ""
    };
}

/** Adresse du proxy : http(s)://hôte[:port], sans identifiants (ils seraient enregistrés en clair). */
export function cleanProxyUrl(v) {
    let s = String(v ?? "").trim();
    if (!s) return "";
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
    let url;
    try { url = new URL(s); } catch { throw new Error(`adresse du proxy invalide : ${v}`); }
    if (!/^https?:$/.test(url.protocol)) throw new Error("proxy : http:// ou https:// attendu");
    if (url.username || url.password) throw new Error("proxy : pas d'identifiants dans l'adresse (ils seraient enregistrés en clair) ; garde-les dans la variable HTTPS_PROXY de ta session");
    if (!url.hostname) throw new Error(`adresse du proxy invalide : ${v}`);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`;
}

/** NO_PROXY : noms, domaines (.intra.client.fr), adresses ou « * », séparés par des virgules ou des espaces. */
export function cleanNoProxy(v) {
    const items = [...new Set(String(v ?? "").split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
    if (items.length > 60) throw new Error("NO_PROXY : 60 entrées au plus");
    for (const it of items) if (!/^[a-z0-9.*_:[\]/-]{1,253}$/.test(it)) throw new Error(`NO_PROXY : entrée invalide « ${it} »`);
    return items.join(",");
}

/** Variables d'environnement pour un proxy actif ({ url, noProxy }) ou aucun (null) : les 6 variables, casse comprise. */
export function proxyEnv(proxy) {
    if (!proxy?.url) return Object.fromEntries(PROXY_VARS.map((k) => [k, undefined]));
    return { HTTPS_PROXY: proxy.url, https_proxy: proxy.url, HTTP_PROXY: proxy.url, http_proxy: proxy.url,
        NO_PROXY: proxy.noProxy || undefined, no_proxy: proxy.noProxy || undefined };
}

/** Le proxy répond-il ? (connexion TCP à son port, 1,5 s au plus ; aucun octet envoyé) */
export function probeProxy(url, timeout = 1500) {
    return new Promise((resolve) => {
        let u;
        try { u = new URL(url); } catch { resolve(false); return; }
        const socket = net.connect({ host: u.hostname, port: Number(u.port) || (u.protocol === "https:" ? 443 : 8080) });
        const done = (ok) => { socket.destroy(); resolve(ok); };
        socket.setTimeout(timeout, () => done(false));
        socket.once("connect", () => done(true));
        socket.once("error", () => done(false));
    });
}

/**
 * État du proxy et application aux variables d'environnement du processus.
 * Événement "change" (state) quand le proxy effectif change (activé, désactivé, autre adresse).
 */
export class ProxyManager extends EventEmitter {
    /**
     * @param getSettings () => { mode, url, noProxy } (réglages enregistrés)
     * @param env         variables à piloter (process.env)
     * @param probe       test de joignabilité (remplaçable pour les tests)
     */
    constructor(getSettings, { env = process.env, probe = probeProxy } = {}) {
        super();
        this.getSettings = getSettings;
        this.env = env;
        this.probe = probe;
        // Variables d'origine : le mode « système » y revient exactement
        this.original = Object.fromEntries(PROXY_VARS.map((k) => [k, env[k]]));
        this.state = { mode: "system", active: false, url: "", noProxy: "", reachable: null, checked: null };
        this.timer = null;
    }

    /** Adresse et NO_PROXY configurés, à défaut ceux des variables d'origine. */
    target() {
        const s = this.getSettings() ?? {};
        const sys = envProxy(this.original);
        return { mode: s.mode ?? "system", url: s.url || sys.url, noProxy: s.noProxy || sys.noProxy, system: sys };
    }

    /** Recalcule le proxy effectif (test de joignabilité en mode auto) et l'applique. */
    async refresh() {
        const t = this.target();
        let active = false, reachable = null;
        if (t.mode === "system") active = Boolean(t.system.url);
        else if (t.mode === "on") active = Boolean(t.url);
        else if (t.mode === "auto" && t.url) active = reachable = await this.probe(t.url);
        const url = active ? (t.mode === "system" ? t.system.url : t.url) : "";
        const noProxy = active ? (t.mode === "system" ? t.system.noProxy : t.noProxy) : "";
        const prev = this.state;
        this.state = { mode: t.mode, active, url, noProxy, configured: t.url, reachable, checked: new Date().toISOString() };
        if (t.mode === "system") {
            for (const k of PROXY_VARS) { if (this.original[k] === undefined) delete this.env[k]; else this.env[k] = this.original[k]; }
        } else {
            for (const [k, v] of Object.entries(proxyEnv(active ? { url, noProxy } : null))) { if (v === undefined) delete this.env[k]; else this.env[k] = v; }
        }
        if (prev.active !== active || prev.url !== url || prev.noProxy !== noProxy || prev.mode !== t.mode) this.emit("change", this.state);
        return this.state;
    }

    /** Test régulier en mode auto (bureau / maison). */
    start() {
        clearInterval(this.timer);
        this.timer = setInterval(() => { if (this.target().mode === "auto") this.refresh().catch(() => {}); }, PROBE_EVERY_MS);
        this.timer.unref?.();
        return this.refresh();
    }

    /** Options git qui imposent le choix (sinon un http.proxy de la configuration git prendrait le dessus). */
    gitArgs() {
        if (this.state.mode === "system") return [];
        const v = this.state.active ? this.state.url : "";
        return ["-c", `http.proxy=${v}`, "-c", `https.proxy=${v}`];
    }
}
