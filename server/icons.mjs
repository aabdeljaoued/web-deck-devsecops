// Icônes des touches : "lucide-<nom>" (jeu Lucide, ISC), sinon icône du projet (public/icons), sinon logo simple-icons (CC0).
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Chemin du fichier SVG d'une icône, ou null si elle n'existe pas (nom limité à [a-z0-9-]). */
export function iconFile(name) {
    if (typeof name !== "string" || !/^[a-z0-9-]+$/.test(name)) return null;
    const candidates = name.startsWith("lucide-")
        ? [path.join(ROOT, "node_modules", "lucide-static", "icons", `${name.slice(7)}.svg`)]
        : [path.join(ROOT, "public", "icons", `${name}.svg`), path.join(ROOT, "node_modules", "simple-icons", "icons", `${name}.svg`)];
    return candidates.find((file) => existsSync(file)) ?? null;
}
