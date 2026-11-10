// Paramètres nommés des commandes ({namespace}, {pod}…) : listes réelles proposées dans la fenêtre de saisie,
// lues avec kubectl (contexte courant) ou le client de conteneurs (docker / podman).
// Commandes lancées sans shell ; le namespace transmis est vérifié (nom Kubernetes valide uniquement).
import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const MAX_ITEMS = 500;

function run(file, args, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        execFile(file, args, { timeout: timeoutMs, windowsHide: true, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) reject(new Error(String(stderr || err.message).trim().split("\n")[0]));
            else resolve(stdout);
        });
    });
}

const K8S_NAME = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;

/** Paramètre -> source : ressource kubectl (avec ou sans namespace) ou liste docker. */
const SOURCES = {
    namespace: { kube: ["get", "namespaces", "-o", "name"] },
    pod: { kube: ["get", "pods", "-o", "name"], namespaced: true },
    deployment: { kube: ["get", "deployments", "-o", "name"], namespaced: true },
    service: { kube: ["get", "services", "-o", "name"], namespaced: true },
    node: { kube: ["get", "nodes", "-o", "name"] },
    context: { kube: ["config", "get-contexts", "-o", "name"] },
    container: { docker: ["ps", "--format", "{{.Names}}"] },
    image: { docker: ["images", "--format", "{{.Repository}}:{{.Tag}}"] },
    host: { ssh: true },
    identity: { keys: true },
    // ports d'un service (suit le namespace et le service saisis)
    port: { servicePorts: true }
};
const ALIASES = { ns: "namespace", deploy: "deployment", svc: "service", ctx: "context", contexte: "context", conteneur: "container", hote: "host", "hôte": "host", serveur: "host", server: "host", identite: "identity", "identité": "identity" };

/** Fichiers de ~/.ssh qui ne sont jamais des clés privées. */
const NOT_KEYS = /^(config|known_hosts(\.old)?|authorized_keys2?|environment|rc)$|\.(pub|old|bak|txt|ppk|md)$/i;

/** Première ligne d'un fichier (64 octets au plus) : l'en-tête d'une clé, jamais son contenu. */
function header(file) {
    let fd;
    try {
        fd = openSync(file, "r");
        const buf = Buffer.alloc(64);
        const n = readSync(fd, buf, 0, 64, 0);
        return buf.subarray(0, n).toString("latin1").split(/\r?\n/)[0];
    } catch {
        return "";
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
}

/**
 * Clés privées de ~/.ssh pour « ssh -i » : fichier avec un .pub à côté, nom classique (id_rsa, id_ed25519…),
 * extension .pem / .key, ou en-tête « -----BEGIN … PRIVATE KEY----- » (seule la première ligne est lue,
 * jamais la clé). Chemin complet, entre guillemets s'il contient un espace. Aucune clé : erreur qui nomme
 * le dossier exploré (affichée dans la fenêtre).
 */
export function sshKeys(dir = path.join(homedir(), ".ssh")) {
    let files;
    try { files = readdirSync(dir); } catch { throw new Error(`dossier introuvable : ${dir}`); }
    const keys = files.filter((f) => !NOT_KEYS.test(f))
        .filter((f) => { try { return statSync(path.join(dir, f)).isFile(); } catch { return false; } })
        .filter((f) => files.includes(`${f}.pub`) || /^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/i.test(f) || /\.(pem|key)$/i.test(f)
            || /^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(header(path.join(dir, f))))
        .sort();
    if (!keys.length) throw new Error(`aucune clé privée dans ${dir}`);
    return keys.map((f) => { const p = path.join(dir, f); return /\s/.test(p) ? `"${p}"` : p; });
}

/**
 * Hôtes de ~/.ssh/config (lignes Host, sans motifs * ? !), Include suivis (chemins relatifs à ~/.ssh,
 * « * » dans le nom de fichier), 5 niveaux au plus. Rien n'est exécuté : le fichier est seulement lu.
 */
export function sshHosts(file = path.join(homedir(), ".ssh", "config"), depth = 0, seen = new Set()) {
    if (depth > 5 || seen.has(file) || !existsSync(file)) return [];
    seen.add(file);
    let text;
    try { if (!statSync(file).isFile()) return []; text = readFileSync(file, "utf8"); } catch { return []; }
    const hosts = [];
    const base = path.join(homedir(), ".ssh");
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/#.*/, "").trim();
        let m;
        if ((m = /^Host\s*[= ]\s*(.+)$/i.exec(line))) {
            hosts.push(...m[1].split(/\s+/).map((h) => h.replace(/^"|"$/g, "")).filter((h) => h && !/[*?!]/.test(h)));
        } else if ((m = /^Include\s+(.+)$/i.exec(line))) {
            for (const pattern of m[1].split(/\s+/)) {
                const p = pattern.replace(/^~(?=$|[\\/])/, homedir());
                const full = path.isAbsolute(p) ? p : path.join(base, p);
                const dir = path.dirname(full);
                const name = path.basename(full);
                if (!name.includes("*")) { hosts.push(...sshHosts(full, depth + 1, seen)); continue; }
                const re = new RegExp(`^${name.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
                let files = [];
                try { files = readdirSync(dir).filter((f) => re.test(f)).sort(); } catch { /* dossier absent */ }
                for (const f of files) hosts.push(...sshHosts(path.join(dir, f), depth + 1, seen));
            }
        }
    }
    return [...new Set(hosts)];
}

/** Nom canonique d'un paramètre à liste réelle, ou null (insensible à la casse). */
export function liveParam(name) {
    const n = String(name ?? "").toLowerCase();
    const key = ALIASES[n] ?? n;
    return SOURCES[key] ? key : null;
}

/** Valeurs proposées pour un paramètre ; hint.namespace limite pods, deployments et services à un namespace. */
export async function paramOptions(ctx, name, hint = {}) {
    const key = liveParam(name);
    if (!key) return [];
    const src = SOURCES[key];
    if (src.ssh) return sshHosts().slice(0, MAX_ITEMS);
    if (src.keys) return sshKeys().slice(0, MAX_ITEMS);
    if (src.servicePorts) {
        const ns = String(hint.namespace ?? "").trim();
        const svc = String(hint.service ?? "").trim();
        if (!svc) return [];
        if (!ctx.apps.kubectl) throw new Error("kubectl introuvable");
        for (const [what, v] of [["namespace", ns], ["service", svc]]) if (v && !K8S_NAME.test(v)) throw new Error(`${what} invalide : ${v}`);
        const args = ["get", "service", svc, "-o", "jsonpath={range .spec.ports[*]}{.port}{\"\\n\"}{end}", ...(ns ? ["-n", ns] : [])];
        const out = await run(ctx.apps.kubectl, args);
        return [...new Set(out.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^\d{1,5}$/.test(l)))];
    }
    let out;
    if (src.kube) {
        if (!ctx.apps.kubectl) throw new Error("kubectl introuvable");
        const args = [...src.kube];
        const ns = String(hint.namespace ?? "").trim();
        if (src.namespaced && ns) {
            if (!K8S_NAME.test(ns)) throw new Error(`namespace invalide : ${ns}`);
            args.push("-n", ns);
        }
        out = await run(ctx.apps.kubectl, args);
    } else {
        const [exe, ...base] = ctx.containerCli;
        out = await run(exe, [...base, ...src.docker]);
    }
    // « kubectl get … -o name » renvoie « pod/web-1 » : préfixe retiré (pas pour les contextes ni les images)
    const strip = src.kube && src.kube[0] === "get";
    return [...new Set(out.split(/\r?\n/).map((l) => (strip ? l.trim().replace(/^[\w.-]+\//, "") : l.trim())).filter((l) => l && !l.includes("<none>")))].slice(0, MAX_ITEMS);
}
