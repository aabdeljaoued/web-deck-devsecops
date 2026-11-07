// Outils installables utilisés par les touches : le deck signale ceux qui manquent et propose
// la commande d'installation (Homebrew sur macOS, Scoop ou pip sur Windows). Les commandes Linux faites
// pour un serveur distant (systemctl, ss…) ne sont pas concernées : seuls les outils listés ici le sont.
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { platform } from "./platform.mjs";

/** Outil -> paquet par système (null = pas de commande proposée sur ce système). */
const INSTALL = {
    stern: { mac: "brew install stern", windows: "scoop install stern" },
    popeye: { mac: "brew install popeye", windows: "scoop install popeye" },
    dive: { mac: "brew install dive", windows: "scoop install dive" },
    gitleaks: { mac: "brew install gitleaks", windows: "scoop install gitleaks" },
    delta: { mac: "brew install git-delta", windows: "scoop install delta" },
    lazygit: { mac: "brew install lazygit", windows: "scoop install lazygit" },
    trivy: { mac: "brew install trivy", windows: "scoop install trivy" },
    checkov: { mac: "brew install checkov", windows: "pip install checkov" },
    semgrep: { mac: "brew install semgrep", windows: "pip install semgrep" },
    "ssh-audit": { mac: "brew install ssh-audit", windows: "pip install ssh-audit" },
    "ansible-lint": { mac: "brew install ansible-lint", windows: null },
    kubectl: { mac: "brew install kubernetes-cli", windows: "scoop install kubectl" },
    helm: { mac: "brew install helm", windows: "scoop install helm" },
    terraform: { mac: "brew install hashicorp/tap/terraform", windows: "scoop install terraform" },
    vault: { mac: "brew install hashicorp/tap/vault", windows: "scoop install vault" },
    htop: { mac: "brew install htop", windows: null }
};

/** Outil à vérifier pour une touche : celui qu'elle déclare (needs), sinon le premier mot de sa commande. */
export const neededTool = (key) => {
    const tool = key?.needs ?? key?.tool;
    return tool && tool in INSTALL ? tool : null;
};

/** Commande d'installation proposée sur ce système (null si aucune). */
export const installCommand = (tool) => INSTALL[tool]?.[platform] ?? null;

/** PATH du shell de connexion (macOS / Linux) : un service lancé par launchd n'a qu'un PATH minimal. */
function loginPath() {
    if (platform === "windows") return Promise.resolve("");
    const shell = process.env.SHELL || "/bin/zsh";
    return new Promise((resolve) => {
        execFile(shell, ["-l", "-c", 'printf "%s" "$PATH"'], { timeout: 5000 }, (err, out) => resolve(err ? "" : String(out)));
    });
}

export class Tools {
    constructor() {
        this.dirs = null;
        this.missing = [];
    }

    async searchDirs() {
        if (this.dirs) return this.dirs;
        const home = os.homedir();
        const extra = platform === "windows"
            ? [path.join(home, "scoop", "shims"), path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Links")]
            : ["/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".local", "bin"), path.join(home, "go", "bin"), path.join(home, ".cargo", "bin")];
        const dirs = [...(await loginPath()).split(path.delimiter), ...(process.env.PATH ?? "").split(path.delimiter), ...extra];
        this.dirs = [...new Set(dirs.filter(Boolean))];
        return this.dirs;
    }

    async installed(tool) {
        const exts = platform === "windows" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.PS1").split(";").map((e) => e.toLowerCase()) : [""];
        for (const dir of await this.searchDirs()) {
            for (const ext of exts) {
                try {
                    const file = path.join(dir, tool + ext);
                    if (existsSync(file) && statSync(file).isFile()) return true;
                } catch { /* dossier illisible : ignoré */ }
            }
        }
        return false;
    }

    /** Vérifie les outils demandés ; renvoie true si la liste des manquants a changé. */
    async check(tools) {
        const missing = [];
        for (const tool of [...new Set(tools)].sort()) if (!(await this.installed(tool))) missing.push(tool);
        const changed = missing.join() !== this.missing.join();
        this.missing = missing;
        return changed;
    }

    /** État envoyé aux pages : outils manquants et commande d'installation de chacun. */
    view() {
        return { missing: this.missing, install: Object.fromEntries(this.missing.map((t) => [t, installCommand(t)])) };
    }
}
