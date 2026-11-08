// Journal des actions lancées depuis le deck (Réglages › Journal) : date, touche, commande, exécutée ou tapée,
// terminal, contexte kubectl (et production). Fichier .deck-journal.jsonl, hors Git, lisible par l'utilisateur seul ;
// les 5 000 dernières entrées sont gardées. Les valeurs du coffre n'y passent jamais (« Taper » un secret n'est pas noté).
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const MAX_ENTRIES = 5000;
const clip = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);

export class Journal {
    constructor(file) {
        this.file = file;
        this.entries = [];
        if (!existsSync(file)) return;
        try {
            this.entries = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).slice(-MAX_ENTRIES);
        } catch (err) {
            console.warn(`  journal illisible : ${err.message} (repart à vide)`);
            this.entries = [];
        }
    }

    /** Ajoute une entrée ; le fichier est réécrit quand il dépasse la limite. */
    add(entry) {
        const e = {
            time: new Date().toISOString(),
            label: clip(entry.label, 60),
            page: clip(entry.page, 60),
            command: clip(entry.command, 600),
            mode: entry.mode === "run" ? "exécutée" : entry.mode === "link" ? "lien" : "tapée",
            terminal: clip(entry.terminal, 60),
            kube: entry.kube ? clip(entry.kube, 120) : null,
            prod: Boolean(entry.prod)
        };
        this.entries.push(e);
        if (this.entries.length > MAX_ENTRIES * 1.1) {
            this.entries = this.entries.slice(-MAX_ENTRIES);
            this.rewrite();
        } else {
            appendFileSync(this.file, `${JSON.stringify(e)}\n`, { mode: 0o600 });
        }
        return e;
    }

    rewrite() {
        writeFileSync(this.file, this.entries.map((e) => JSON.stringify(e)).join("\n") + (this.entries.length ? "\n" : ""), { mode: 0o600 });
        try { chmodSync(this.file, 0o600); } catch { /* Windows */ }
    }

    /** Dernières entrées, la plus récente d'abord. */
    recent(n = 200) {
        return this.entries.slice(-n).reverse();
    }

    clear() {
        this.entries = [];
        this.rewrite();
    }

    /** Export CSV (séparateur « ; », lisible par Excel en français). */
    csv() {
        const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
        const head = ["date", "action", "rubrique", "commande", "mode", "terminal", "contexte kubectl", "production"];
        return [head.join(";"), ...this.entries.map((e) => [new Date(e.time).toLocaleString("fr-FR"), e.label, e.page, e.command, e.mode, e.terminal, e.kube ?? "", e.prod ? "oui" : ""].map(cell).join(";"))].join("\r\n");
    }
}
