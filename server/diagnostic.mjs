// Diagnostic (Réglages › Serveur) : vérifie sur la machine du deck ce qui dépend du système
// (presse-papiers, détection ssh / wsl, outils, sauvegardes, mode de lancement). Utile surtout sous Windows.
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";

import { checkCert } from "./certs.mjs";
import { read as readClipboard, write as writeClipboard } from "./clipboard.mjs";
import { platform } from "./platform.mjs";

/** Exécute une vérification ; une exception devient un échec avec son message. */
async function check(name, fn) {
    const started = Date.now();
    try {
        const { ok = true, detail = "", warn = false } = (await fn()) ?? {};
        return { name, ok, warn, detail, ms: Date.now() - started };
    } catch (err) {
        return { name, ok: false, detail: err.message.split("\n")[0], ms: Date.now() - started };
    }
}

/**
 * @param deps { ctx, remote, tools, backups, supervisor, localUnix, deckTools }
 */
/** URL du proxy sans identifiants (affichée dans le diagnostic). */
const maskProxy = (raw) => String(raw ?? "").replace(/\/\/[^/@]*@/, "//•••@");

/**
 * Réseau : proxy, DNS, accès HTTPS (et interception TLS) et accès Git pour « Mettre à jour ».
 * Utile sur un poste d'entreprise (proxy obligatoire, DNS interne).
 */
/**
 * @param proxy { label, gitArgs } : mode choisi dans Réglages › Proxy (texte affiché) et options git correspondantes
 */
export async function networkChecks(root, env = process.env, proxy = {}) {
    const checks = [];
    const proxyUrl = env.HTTPS_PROXY || env.https_proxy || "";
    const noProxy = env.NO_PROXY || env.no_proxy || "";
    const source = proxy.label ?? "variable HTTPS_PROXY";
    checks.push(await check("Proxy", () => ({
        detail: proxyUrl ? `${maskProxy(proxyUrl)}${noProxy ? ` · NO_PROXY : ${noProxy}` : ""} (${source})` : `aucun : connexion directe (${proxy.label ?? "HTTPS_PROXY non défini"})`
    })));
    const dns = await check("DNS (nom public)", async () => {
        const { address } = await lookup("github.com");
        return { detail: `github.com → ${address}` };
    });
    // Derrière un proxy, c'est lui qui résout les noms publics : un échec ici n'est pas bloquant
    checks.push(dns.ok || !proxyUrl ? dns : { ...dns, ok: true, warn: true, detail: `${dns.detail} : normal derrière un proxy (c'est lui qui résout les noms)` });
    checks.push(await check("Accès HTTPS (github.com)", async () => {
        const cert = await checkCert("github.com", 443, { env });
        const how = cert.via ? `via le proxy ${cert.via}` : "en direct";
        if (cert.intercepted) {
            return { warn: true, detail: `${how}, mais le TLS est déchiffré par le proxy (certificat émis par ${cert.issuer}) : git, npm ou kubectl peuvent exiger le certificat racine de l'entreprise` };
        }
        return { detail: `${how} · certificat émis par ${cert.issuer}` };
    }));
    checks.push(await check("Accès Git (Mettre à jour)", () => new Promise((resolve) => {
        if (!existsSync(path.join(root, ".git"))) return resolve({ warn: true, detail: "dossier hors Git : mise à jour à la main" });
        execFile("git", [...(proxy.gitArgs ?? []), "ls-remote", "--heads", "origin"], { cwd: root, timeout: 15000, windowsHide: true, env }, (err, _out, stderr) => {
            if (!err) return resolve({ detail: "dépôt GitHub joignable" });
            const why = String(stderr || err.message || "").trim().split("\n").pop();
            resolve({ ok: false, detail: `${why || "échec"} · ${proxyUrl ? "proxy utilisé : essaie Réglages › Proxy › Désactivé (hors du bureau) ou Automatique" : "connexion directe : au bureau, essaie Réglages › Proxy › Activé ou Automatique"}` });
        });
    })));
    return checks;
}

export async function runDiagnostic({ ctx, remote, tools, backups, supervisor, localUnix, deckTools, root, proxy }) {
    const checks = [];

    checks.push(await check("Système", () => ({
        detail: `${platform} ${os.release()} · Node ${process.version} · ${os.hostname()}`
    })));

    checks.push(await check("Shells", () => {
        const names = ctx.shells.map((s) => s.name);
        return { ok: names.length > 0, detail: names.length ? names.join(", ") : "aucun shell trouvé (voir \"shells\" dans paths.json)" };
    }));

    checks.push(await check("Lancement", () => ({
        warn: !supervisor,
        detail: supervisor ? `service ${supervisor} (relancé s'il s'arrête)`
            : "à la main : fermer sa fenêtre arrête le deck (service : dossier service/)"
    })));

    // Presse-papiers : écrit un repère, le relit, puis remet le contenu d'origine
    checks.push(await check("Presse-papiers (Copier un secret)", async () => {
        const before = await readClipboard();
        const marker = `deck-diagnostic-${Date.now()}`;
        await writeClipboard(marker);
        const got = await readClipboard();
        await writeClipboard(before ?? "").catch(() => {});
        if (got == null) return { ok: false, detail: "lecture impossible" };
        const ok = got.replace(/\r?\n$/, "") === marker;
        return { ok, detail: ok ? "écriture et lecture OK (contenu d'origine remis)" : `relu : « ${got.slice(0, 40)} »` };
    }));

    // Détection ssh / wsl : la liste des processus doit contenir le serveur lui-même
    checks.push(await check("Détection ssh / wsl (Ansible)", async () => {
        const started = Date.now();
        const procs = await remote.snapshot();
        const self = procs.some((p) => p.pid === process.pid);
        return {
            ok: self && remote.watching,
            detail: `${procs.length} processus lus en ${Date.now() - started} ms${self ? "" : ", serveur absent de la liste"}${remote.watching ? "" : ", surveillance arrêtée"}`
        };
    }));

    checks.push(await check("Rubriques Linux / macOS", () => ({
        detail: localUnix ? "poste Linux / macOS : Ansible actif en local"
            : "poste Windows : Ansible actif dans un terminal connecté en ssh / wsl"
    })));

    checks.push(await check("Outils installables", async () => {
        await tools.check(deckTools());
        const { missing } = tools.view();
        const manager = platform === "mac" ? "brew" : platform === "windows" ? "scoop" : null;
        const managerOk = !manager || (await tools.installed(manager));
        return {
            ok: true,
            warn: missing.length > 0 || !managerOk,
            detail: [
                missing.length ? `à installer : ${missing.join(", ")}` : "tous les outils des touches sont installés",
                manager ? `${manager} ${managerOk ? "présent" : "introuvable : un clic sur une touche « à installer » propose de l'installer (sans droits admin)"}` : ""
            ].filter(Boolean).join(" · ")
        };
    }));

    checks.push(await check("Sauvegardes (.deck-backups)", () => {
        mkdirSync(backups.dir, { recursive: true, mode: 0o700 });
        const probe = path.join(backups.dir, ".diagnostic");
        writeFileSync(probe, "ok");
        unlinkSync(probe);
        return { detail: "dossier accessible en écriture" };
    }));

    checks.push(await check("Workspace", () => ({ ok: existsSync(ctx.workspace), detail: ctx.workspace })));

    if (root) checks.push(...(await networkChecks(root, process.env, proxy)));
    return checks;
}
