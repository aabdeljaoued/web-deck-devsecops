// Paramètres nommés des commandes ({namespace}, {pod}…) : listes réelles proposées dans la fenêtre de saisie,
// lues avec kubectl (contexte courant) ou le client de conteneurs (docker / podman).
// Commandes lancées sans shell ; le namespace transmis est vérifié (nom Kubernetes valide uniquement).
import { execFile } from "node:child_process";

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
    image: { docker: ["images", "--format", "{{.Repository}}:{{.Tag}}"] }
};
const ALIASES = { ns: "namespace", deploy: "deployment", svc: "service", ctx: "context", contexte: "context", conteneur: "container" };

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
