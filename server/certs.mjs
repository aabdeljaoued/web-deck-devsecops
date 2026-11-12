// Lecture du certificat présenté par un serveur TLS (voyant « certificats » des missions).
// Connexion directe, ou tunnel HTTP CONNECT par le proxy de HTTPS_PROXY / https_proxy (réseaux d'entreprise où
// toute sortie passe par un proxy, ex. Zscaler, et où le DNS interne ne résout pas les noms publics).
// NO_PROXY / no_proxy respecté. Rien d'autre n'est envoyé au serveur que la poignée de main TLS.
import { isIP } from "node:net";
import net from "node:net";
import tls from "node:tls";

export const TIMEOUT_MS = 10000;

/** Erreurs réseau en clair (panneau des certificats). */
const NET_ERRORS = {
    ENOTFOUND: "nom inconnu du DNS",
    EAI_AGAIN: "DNS indisponible",
    ENETUNREACH: "réseau inaccessible, VPN ou proxy ?",
    EHOSTUNREACH: "hôte inaccessible, VPN ou proxy ?",
    ECONNREFUSED: "port fermé",
    ECONNRESET: "connexion coupée",
    ETIMEDOUT: "délai dépassé"
};

/**
 * Émetteurs des proxys qui déchiffrent le TLS (ils présentent leur propre certificat) : la date lue est alors
 * celle du proxy, pas celle du site.
 */
const INTERCEPTION = /zscaler|netskope|fortinet|fortigate|palo ?alto|blue ?coat|symantec web|forcepoint|websense|cisco umbrella|sophos|mcafee web|skyhigh|checkpoint|check point|squid|mitmproxy/i;

export function isInterception(issuer) {
    return INTERCEPTION.test(String(issuer ?? ""));
}

/**
 * Proxy à utiliser pour un hôte : URL de HTTPS_PROXY (ou https_proxy), sauf si NO_PROXY le désigne.
 * NO_PROXY : liste séparée par des virgules ou des espaces ; « * » = jamais de proxy ; « example.com » ou
 * « .example.com » couvre aussi les sous-domaines ; un port peut être précisé (« hote:8443 »).
 */
export function proxyFor(host, port = 443, env = process.env) {
    const raw = env.HTTPS_PROXY || env.https_proxy || "";
    if (!raw) return null;
    const noProxy = String(env.NO_PROXY ?? env.no_proxy ?? "").split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    const h = String(host).toLowerCase();
    for (const entry of noProxy) {
        if (entry === "*") return null;
        const [name, p] = entry.split(/:(?=\d+$)/);
        if (p && Number(p) !== Number(port)) continue;
        const bare = name.replace(/^\*?\./, "");
        if (h === bare || h.endsWith(`.${bare}`)) return null;
    }
    let url;
    try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`); } catch { throw new Error(`HTTPS_PROXY invalide : ${raw}`); }
    if (!/^https?:$/.test(url.protocol)) throw new Error(`proxy non pris en charge : ${url.protocol} (http:// ou https:// attendu)`);
    return {
        host: url.hostname.replace(/^\[|\]$/g, ""),
        port: Number(url.port) || (url.protocol === "https:" ? 443 : 8080),
        tls: url.protocol === "https:",
        auth: url.username ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}` : null,
        label: `${url.hostname}:${Number(url.port) || (url.protocol === "https:" ? 443 : 8080)}`
    };
}

/** Tunnel CONNECT : socket ouverte vers host:port à travers le proxy (réponse 200 attendue). */
function tunnel(proxy, host, port, deadline) {
    return new Promise((resolve, reject) => {
        const onError = (err) => reject(new Error(`proxy injoignable (${proxy.label}) : ${NET_ERRORS[err.code] ?? err.code ?? err.message}`));
        const socket = proxy.tls
            ? tls.connect({ host: proxy.host, port: proxy.port, servername: isIP(proxy.host) ? undefined : proxy.host })
            : net.connect({ host: proxy.host, port: proxy.port });
        socket.setTimeout(Math.max(1000, deadline - Date.now()), () => { socket.destroy(); reject(new Error(`délai dépassé (proxy ${proxy.label})`)); });
        socket.once("error", onError);
        socket.once(proxy.tls ? "secureConnect" : "connect", () => {
            const target = `${host.includes(":") ? `[${host}]` : host}:${port}`;
            const auth = proxy.auth ? `Proxy-Authorization: Basic ${Buffer.from(proxy.auth).toString("base64")}\r\n` : "";
            socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`);
        });
        let head = Buffer.alloc(0);
        const onData = (chunk) => {
            head = Buffer.concat([head, chunk]);
            const end = head.indexOf("\r\n\r\n");
            if (end < 0) {
                if (head.length > 16384) { socket.destroy(); reject(new Error("réponse du proxy illisible")); }
                return;
            }
            socket.off("data", onData);
            socket.off("error", onError);
            const status = Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(head.toString("latin1"))?.[1]);
            if (status === 200) {
                const rest = head.subarray(end + 4);
                if (rest.length) socket.unshift(rest);
                return resolve(socket);
            }
            socket.destroy();
            const why = status === 407 ? "authentification du proxy demandée (407)"
                : status === 403 ? "le proxy refuse cette destination (403)"
                : [502, 503, 504].includes(status) ? `le proxy n'atteint pas l'hôte (${status})`
                : `réponse du proxy ${status || "inconnue"}`;
            reject(new Error(why));
        };
        socket.on("data", onData);
    });
}

const field = (obj, key) => (Array.isArray(obj?.[key]) ? obj[key].join(", ") : obj?.[key]) ?? "";

/** Une tentative : poignée de main TLS directe, ou à travers le tunnel CONNECT du proxy. */
async function attempt(host, port, proxy, timeout) {
    const deadline = Date.now() + timeout;
    const socket = proxy ? await tunnel(proxy, host, port, deadline) : null;
    return new Promise((resolve, reject) => {
        const options = { servername: isIP(host) ? undefined : host, rejectUnauthorized: false };
        const conn = socket ? tls.connect({ ...options, socket }) : tls.connect({ ...options, host, port });
        conn.setTimeout(Math.max(1000, deadline - Date.now()), () => { conn.destroy(); reject(new Error("délai dépassé")); });
        conn.once("secureConnect", () => {
            const cert = conn.getPeerCertificate();
            const validTo = new Date(cert.valid_to);
            const issuer = field(cert.issuer, "O") || field(cert.issuer, "CN");
            const out = {
                validTo,
                subject: field(cert.subject, "CN"),
                issuer: [field(cert.issuer, "CN"), field(cert.issuer, "O")].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(" · "),
                san: String(cert.subjectaltname ?? "").replace(/DNS:/g, "").split(/,\s*/).filter(Boolean).slice(0, 10),
                trusted: conn.authorized,
                reason: conn.authorizationError ? String(conn.authorizationError) : null,
                via: proxy ? proxy.label : null,
                intercepted: isInterception(issuer) || isInterception(field(cert.issuer, "CN"))
            };
            conn.end();
            if (!cert.valid_to || Number.isNaN(validTo.getTime())) reject(new Error("aucun certificat présenté"));
            else resolve(out);
        });
        conn.once("error", (err) => reject(new Error(NET_ERRORS[err.code] ?? err.code ?? err.message)));
    });
}

/** Chemin qui a fonctionné pour chaque hôte:port ("direct" | "proxy") : essayé en premier la fois suivante. */
const routes = new Map();

/**
 * Certificat du serveur host:port : { validTo, subject, issuer, san, trusted, reason, via, direct, intercepted }.
 * La chaîne n'est pas exigée valide (auto-signé, autorité interne) : `trusted` / `reason` le disent.
 * Avec un proxy : si le proxy n'atteint pas l'hôte (502/503/504, refus, proxy injoignable, délai), essai en direct
 * (noms internes d'entreprise, joignables seulement depuis le réseau interne ou le VPN) ; le chemin qui a fonctionné
 * est retenu pour la vérification suivante. Les deux échecs sont alors rapportés.
 */
export async function checkCert(host, port = 443, { env = process.env, timeout = TIMEOUT_MS } = {}) {
    const proxy = proxyFor(host, port, env);
    if (!proxy) return attempt(host, port, null, timeout);
    const key = `${host}:${port}`;
    const order = routes.get(key) === "direct" ? ["direct", "proxy"] : ["proxy", "direct"];
    const errors = {};
    for (const route of order) {
        try {
            const out = await attempt(host, port, route === "proxy" ? proxy : null, timeout);
            routes.set(key, route);
            return { ...out, direct: route === "direct" };
        } catch (err) {
            errors[route] = err.message;
        }
    }
    routes.delete(key);
    throw new Error(`par le proxy : ${errors.proxy} ; en direct : ${errors.direct}`);
}

/** Oublie les chemins retenus (tests, changement de réseau). */
export function resetRoutes() { routes.clear(); }
