// Lecture de config.jsonc (QUOI afficher) et paths.json (OÙ sont les logiciels).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc, printParseErrorCode } from "jsonc-parser";

import { expand, isMac, platform, refreshPath, resolveExe, shellKind } from "./platform.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJsonc(file) {
    const errors = [];
    const data = parseJsonc(readFileSync(file, "utf8"), errors, { allowTrailingComma: true });
    if (errors.length) {
        const { error, offset } = errors[0];
        throw new Error(`${path.basename(file)} : ${printParseErrorCode(error)} (position ${offset})`);
    }
    return data;
}

/** Fusion profonde : les objets sont fusionnés, le reste (tableaux compris) est remplacé. */
function merge(base, over) {
    if (!over || typeof over !== "object" || Array.isArray(over)) return over ?? base;
    const out = { ...base };
    for (const [k, v] of Object.entries(over)) out[k] = merge(base?.[k], v);
    return out;
}

/** Premier candidat trouvé (chemin complet ou nom cherché dans le PATH), sinon null. */
function resolveApp(value) {
    for (const candidate of [value].flat()) {
        const found = resolveExe(expand(candidate));
        if (found) return found;
    }
    return null;
}

export function loadConfig() {
    refreshPath();
    const cfg = readJsonc(path.join(ROOT, "config.jsonc"));

    const machine = hostname().split(".")[0];
    const machineFile = path.join(ROOT, `paths.${machine}.json`);
    let paths = readJsonc(path.join(ROOT, "paths.json"));
    if (existsSync(machineFile)) paths = merge(paths, readJsonc(machineFile));
    // Linux : pas de bloc dédié obligatoire, on reprend celui de macOS (shells et outils Unix)
    const P = paths[platform] ?? (platform === "linux" ? paths.mac : null) ?? {};

    const workspace = expand(P.workspace ?? "~");
    const apps = Object.fromEntries(Object.entries(P.apps ?? {}).map(([name, value]) => [name, resolveApp(value)]));
    // macOS sans outils de ligne de commande Xcode : /usr/bin/git n'est qu'un leurre qui ouvre
    // une fenêtre d'installation à chaque appel (le voyant Git en ferait une toutes les 5 s)
    if (isMac && apps.git === "/usr/bin/git" && !hasXcodeTools()) apps.git = null;

    // Shells : un seul par nom (le premier trouvé)
    const shells = [];
    for (const shell of P.shells ?? []) {
        if (shells.some((s) => s.name === shell.name)) continue;
        const [exe, ...args] = shell.command;
        const found = resolveExe(expand(exe));
        if (found) shells.push({ name: shell.name, kind: shell.kind ?? shellKind(found), command: [found, ...args.map(expand)] });
    }

    const [cliExe, ...cliArgs] = P.containerCli ?? ["docker"];
    return {
        cfg,
        machine,
        machineFile: existsSync(machineFile) ? path.basename(machineFile) : null,
        port: cfg.port ?? 7777,
        workspace: existsSync(workspace) ? workspace : homedir(),
        gitRoots: (P.gitRoots ?? [workspace]).map(expand),
        containerCli: [resolveExe(expand(cliExe)) ?? cliExe, ...cliArgs],
        containerLabel: P.containerLabel ?? "DOCKER",
        shells,
        apps
    };
}

function hasXcodeTools() {
    try {
        execFileSync("xcode-select", ["-p"], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}
