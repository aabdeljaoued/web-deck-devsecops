// Presse-papiers du système, utilisé par le serveur pour copier un secret du coffre : la valeur ne passe pas
// par la page (comme « Taper »), et l'effacement après 30 s ne dépend pas d'un geste dans le navigateur.
// macOS : pbcopy / pbpaste ; Windows : PowerShell (Set-Clipboard / Get-Clipboard) ; Linux : wl-copy ou xclip.
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";

import { platform } from "./platform.mjs";

const PS = ["-NoProfile", "-NonInteractive", "-STA", "-Command"];

/** Commande d'écriture (valeur sur l'entrée standard) et de lecture pour ce système. */
function tools() {
    if (platform === "mac") return { write: ["pbcopy", []], read: ["pbpaste", []] };
    if (platform === "windows") {
        return {
            write: ["powershell.exe", [...PS, "[Console]::InputEncoding = [Text.Encoding]::UTF8; $v = [Console]::In.ReadToEnd(); if ($v) { Set-Clipboard -Value $v } else { Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::Clear() }"]],
            read: ["powershell.exe", [...PS, "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Clipboard -Raw"]]
        };
    }
    return process.env.WAYLAND_DISPLAY
        ? { write: ["wl-copy", []], read: ["wl-paste", ["--no-newline"]] }
        : { write: ["xclip", ["-selection", "clipboard"]], read: ["xclip", ["-selection", "clipboard", "-o"]] };
}

export function write(text) {
    const [cmd, args] = tools().write;
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
        child.on("error", () => reject(new Error(`presse-papiers indisponible (${cmd} introuvable)`)));
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`presse-papiers : ${cmd} a échoué (code ${code})`))));
        child.stdin.end(text, "utf8");
    });
}

export function read() {
    const [cmd, args] = tools().read;
    return new Promise((resolve) => {
        execFile(cmd, args, { windowsHide: true, maxBuffer: 1024 * 1024 }, (err, out) => resolve(err ? null : String(out)));
    });
}

const digest = (text) => createHash("sha256").update(text, "utf8").digest("hex");
let clearTimer = null;
let pendingClear = null;   // effacement prévu (fonction), exécuté tout de suite si le serveur s'arrête avant

/** Effacement en attente exécuté maintenant (arrêt ou redémarrage du serveur avant les 30 s). */
export async function flushClipboard() {
    if (!pendingClear) return;
    clearTimeout(clearTimer);
    const run = pendingClear;
    pendingClear = null;
    await run();
}

/**
 * Copie une valeur, puis l'efface au bout de `seconds` si le presse-papiers la contient toujours
 * (une autre copie faite entre-temps n'est pas effacée). Seule l'empreinte de la valeur est gardée en mémoire.
 */
export async function copyTemporarily(text, seconds = 30) {
    await write(text);
    const expected = digest(text);
    clearTimeout(clearTimer);
    pendingClear = async () => {
        const current = await read();
        // Windows ajoute parfois une fin de ligne à la lecture
        if (current != null && (digest(current) === expected || digest(current.replace(/\r?\n$/, "")) === expected)) {
            await write("").catch(() => {});
        }
    };
    clearTimer = setTimeout(() => { const run = pendingClear; pendingClear = null; run?.(); }, seconds * 1000);
    clearTimer.unref();
}
