// Utilisé par start.cmd / start.sh : code de sortie 0 si "npm install" est nécessaire, 1 sinon.
// Nécessaire si node_modules manque, ou si package.json / package-lock.json ont changé depuis
// la dernière installation (ex. après un git pull qui ajoute une dépendance).
//
//   node server/needs-install.mjs          teste
//   node server/needs-install.mjs --done   enregistre une installation réussie
import { existsSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const marker = path.join(root, "node_modules", ".deck-installed");

if (process.argv.includes("--done")) {
    writeFileSync(marker, new Date().toISOString());
    process.exit(0);
}

const mtime = (file) => (existsSync(file) ? statSync(file).mtimeMs : 0);
const installed = mtime(marker);
const changed = ["package.json", "package-lock.json"].some((f) => mtime(path.join(root, f)) > installed);
process.exit(!installed || changed ? 0 : 1);
