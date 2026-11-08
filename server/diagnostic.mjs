// Diagnostic (Réglages › Serveur) : vérifie sur la machine du deck ce qui dépend du système
// (presse-papiers, détection ssh / wsl, outils, sauvegardes, mode de lancement). Utile surtout sous Windows.
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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
export async function runDiagnostic({ ctx, remote, tools, backups, supervisor, localUnix, deckTools }) {
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
        const { missing, install } = tools.view();
        const manager = platform === "mac" ? "brew" : platform === "windows" ? "scoop" : null;
        const managerOk = !manager || (await tools.installed(manager));
        const noCmd = missing.filter((t) => !install[t]);
        return {
            ok: managerOk,
            warn: missing.length > 0,
            detail: [
                missing.length ? `à installer : ${missing.join(", ")}` : "tous les outils des touches sont installés",
                manager ? `${manager} ${managerOk ? "présent" : "introuvable : les commandes d'installation proposées ne marcheront pas"}` : "",
                noCmd.length ? `sans commande proposée ici : ${noCmd.join(", ")}` : ""
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

    return checks;
}
