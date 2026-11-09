// Enregistrement d'une session de terminal (preuve d'intervention, compte rendu) : format asciinema v2 (.cast,
// rejouable avec « asciinema play ») et, à l'arrêt, une version texte sans couleurs (.txt).
// Seule la SORTIE du terminal est enregistrée (ce qui s'affiche), jamais la frappe : un mot de passe tapé à une
// invite (non affiché) n'y figure pas. Les notes du coffre affichées dans le terminal le sont par la page, pas
// par le shell : elles n'y figurent pas non plus. Dossier .deck-recordings/ (hors Git).
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export const MAX_BYTES = 50 * 1024 * 1024;   // arrêt automatique au-delà (fichier .cast)

// Heure locale (celle de l'intervention), pas UTC : 2026-11-09_21-49-21
const pad = (n) => String(n).padStart(2, "0");
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
const safe = (s) => String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

/** Texte lisible : séquences ANSI et caractères de contrôle retirés, retours chariot normalisés. */
export function castToText(cast) {
    const out = [];
    for (const line of cast.split("\n").slice(1)) {
        if (!line.trim()) continue;
        try {
            const [, type, data] = JSON.parse(line);
            if (type === "o") out.push(data);
        } catch { /* ligne tronquée (arrêt brutal) */ }
    }
    return out.join("")
        .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")          // OSC (titre de fenêtre…)
        .replace(/\x1b\[[0-9;?<>=!]*[ -/]*[@-~]/g, "")            // CSI (couleurs, curseur…)
        .replace(/\x1b[@-Z\\-_]/g, "")
        .replace(/\r+\n/g, "\n")
        .split("\n").map((l) => l.split("\r").pop()).join("\n")   // ligne réécrite (\r) : dernière version
        .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

export class Recorder {
    constructor(dir) {
        this.dir = dir;
        this.active = new Map();   // sid -> { file, stream, start, bytes, label }
    }

    /** Démarre l'enregistrement d'un terminal ; renvoie le nom du fichier. */
    start(sid, { cols = 100, rows = 30, label = "" } = {}) {
        if (this.active.has(sid)) return path.basename(this.active.get(sid).file);
        mkdirSync(this.dir, { recursive: true });
        const now = new Date();
        const file = path.join(this.dir, `${stamp(now)}_${safe(label) || `terminal-${sid}`}.cast`);
        const stream = createWriteStream(file, { flags: "wx", mode: 0o600 });
        const header = { version: 2, width: cols, height: rows, timestamp: Math.floor(now / 1000), title: String(label).slice(0, 80), env: { TERM: "xterm-256color" } };
        stream.write(`${JSON.stringify(header)}\n`);
        this.active.set(sid, { file, stream, start: Date.now(), bytes: 0, label });
        return path.basename(file);
    }

    /** Sortie du terminal ; false si la taille maximale est atteinte (l'appelant arrête l'enregistrement). */
    write(sid, data) {
        const rec = this.active.get(sid);
        if (!rec) return true;
        const line = `${JSON.stringify([Number(((Date.now() - rec.start) / 1000).toFixed(3)), "o", data])}\n`;
        rec.bytes += Buffer.byteLength(line);
        rec.stream.write(line);
        return rec.bytes < MAX_BYTES;
    }

    /** Arrête ; écrit la version texte. Renvoie { cast, txt, seconds } ou null. */
    stop(sid) {
        const rec = this.active.get(sid);
        if (!rec) return Promise.resolve(null);
        this.active.delete(sid);
        return new Promise((resolve) => {
            rec.stream.end(() => {
                const txt = rec.file.replace(/\.cast$/, ".txt");
                try { writeFileSync(txt, castToText(readFileSync(rec.file, "utf8")), { mode: 0o600 }); } catch { /* texte facultatif */ }
                resolve({ cast: path.basename(rec.file), txt: path.basename(txt), seconds: Math.round((Date.now() - rec.start) / 1000) });
            });
        });
    }

    sids() {
        return [...this.active.keys()];
    }

    /**
     * Contenu d'un enregistrement pour le lecteur de la page : seulement un .cast de ce dossier, désigné par
     * son nom exact (aucun chemin), 20 Mo au plus.
     */
    read(name) {
        const file = String(name ?? "");
        if (!/^[A-Za-z0-9._-]+\.cast$/.test(file) || file.startsWith(".")) throw new Error("enregistrement invalide");
        const full = path.join(this.dir, file);
        if (!existsSync(full)) throw new Error("enregistrement introuvable");
        if (statSync(full).size > 20 * 1024 * 1024) throw new Error("enregistrement trop gros pour le lecteur (20 Mo au plus) : utilise asciinema play");
        return readFileSync(full, "utf8");
    }

    /** Enregistrements sur disque, plus récents d'abord. */
    list(limit = 50) {
        if (!existsSync(this.dir)) return [];
        return readdirSync(this.dir).filter((f) => f.endsWith(".cast"))
            .map((f) => { const s = statSync(path.join(this.dir, f)); return { name: f, size: s.size, time: s.mtime.toISOString() }; })
            .sort((a, b) => b.time.localeCompare(a.time)).slice(0, limit);
    }
}
