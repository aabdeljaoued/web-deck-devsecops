// Tout ce qui diffère entre Windows et macOS : variables, PATH, shells, lancement de programmes.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const isWindows = process.platform === "win32";
export const isMac = process.platform === "darwin";
/** Nom du bloc utilisé dans paths.json et dans les variantes de commandes. */
export const platform = isWindows ? "windows" : isMac ? "mac" : "linux";

/** Développe %VAR% (Windows), $VAR / ${VAR} et ~. */
export function expand(value) {
    if (typeof value !== "string") return value;
    return value
        .replace(/%([^%]+)%/g, (m, name) => process.env[name] ?? m)
        .replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, name) => process.env[name] ?? m)
        .replace(/^~(?=$|[\\/])/, homedir());
}

/**
 * Complète le PATH du serveur pour trouver les mêmes outils qu'un terminal neuf :
 * Windows : PATH utilisateur et machine relus depuis le registre ; macOS : dossiers Homebrew.
 */
export function refreshPath() {
    const extra = [];
    if (isWindows) {
        for (const key of ["HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment", "HKCU\\Environment"]) {
            const value = regQuery(key, "Path");
            if (value) extra.push(...expand(value).split(";"));
        }
    } else {
        extra.push("/opt/homebrew/bin", "/usr/local/bin", path.join(homedir(), ".local", "bin"));
    }
    const current = (process.env.PATH ?? "").split(path.delimiter);
    process.env.PATH = [...new Set([...current, ...extra].filter(Boolean))].join(path.delimiter);
}

/** Chemin complet d'un exécutable : tel quel s'il contient un dossier, sinon cherché dans le PATH ; null si introuvable. */
export function resolveExe(name) {
    if (!name) return null;
    if (/[\\/]/.test(name)) return existsSync(name) ? name : null;
    // Windows : "kubectl" -> kubectl.exe, kubectl.cmd... selon PATHEXT
    const names = isWindows && !path.extname(name)
        ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((ext) => name + ext.toLowerCase())
        : [name];
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
        for (const n of names) {
            const candidate = path.join(dir, n);
            if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
        }
    }
    return null;
}

/** Lance un programme détaché du serveur. Rejette si l'exécutable ne démarre pas. */
export function launch([exe, ...args]) {
    return new Promise((resolve, reject) => {
        // Les .cmd / .bat ne se lancent que via le shell sous Windows
        const shell = isWindows && /\.(cmd|bat)$/i.test(exe);
        const child = spawn(exe, args, { detached: true, stdio: "ignore", shell });
        child.once("spawn", () => {
            child.unref();
            resolve();
        });
        child.once("error", reject);
    });
}

/** Ouvre une URL dans le navigateur par défaut. */
export function openBrowser(url) {
    const cmd = isWindows ? ["rundll32.exe", "url.dll,FileProtocolHandler", url] : isMac ? ["open", url] : ["xdg-open", url];
    return launch(cmd).catch(() => {});
}

/** Lit une valeur du registre Windows via reg.exe ; null si absente. */
function regQuery(key, name) {
    try {
        const out = execFileSync("reg", ["query", key, "/v", name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        const m = new RegExp(`^\\s+${name}\\s+REG_\\w+\\s+(.*)$`, "m").exec(out);
        return m ? m[1].trim() : null;
    } catch {
        return null;
    }
}
