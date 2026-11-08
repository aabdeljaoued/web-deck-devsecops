// Sauvegardes automatiques des données hors Git (favoris, coffre, réglages) dans .deck-backups/ (exclu de Git).
// Avant chaque écriture, la version actuelle est copiée (au plus une copie toutes les 10 min, ou toujours
// avant une opération destructrice) ; les 10 dernières copies de chaque fichier sont gardées.
// Le coffre reste chiffré dans ses copies ; toutes les copies sont lisibles par l'utilisateur seul.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";

export const BACKUP_FILES = ["favoris.json", "vault.enc", "settings.json", "actions.json"];
const KEEP = 10;
const MIN_INTERVAL_MS = 10 * 60 * 1000;

export class Backups {
    constructor(dir) {
        this.dir = dir;
    }

    /** Copies d'un fichier, de la plus récente à la plus ancienne : { id, time, size }. */
    list(name) {
        if (!BACKUP_FILES.includes(name) || !existsSync(this.dir)) return [];
        return readdirSync(this.dir)
            .filter((f) => f.startsWith(`${name}.`) && /^\d{8}-\d{6}-\d{3}$/.test(f.slice(name.length + 1)))
            .map((f) => {
                // Date de la copie : celle de son nom (UTC), pas celle du fichier (une copie peut garder la date de l'original)
                const [, d, t, ms] = /(\d{8})-(\d{6})-(\d{3})$/.exec(f);
                const time = Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +t.slice(0, 2), +t.slice(2, 4), +t.slice(4, 6), +ms);
                return { id: f, time, size: statSync(path.join(this.dir, f)).size };
            })
            .sort((a, b) => b.id.localeCompare(a.id));
    }

    /** Toutes les copies, par fichier (pour les Réglages). */
    all() {
        return Object.fromEntries(BACKUP_FILES.map((name) => [name, this.list(name)]));
    }

    /**
     * À appeler juste avant d'écrire file : copie la version actuelle.
     * force = copie même si la dernière a moins de 10 min (avant une opération destructrice).
     */
    before(file, { force = false } = {}) {
        const name = path.basename(file);
        if (!BACKUP_FILES.includes(name) || !existsSync(file)) return null;
        try {
            const last = this.list(name)[0];
            if (!force && last && Date.now() - last.time < MIN_INTERVAL_MS) return null;
            mkdirSync(this.dir, { recursive: true, mode: 0o700 });
            // Nom horodaté unique (à la milliseconde près ; décalé si deux copies tombent dans la même)
            const stampOf = (ms) => new Date(ms).toISOString().replace(/\D/g, "").replace(/^(\d{8})(\d{6})(\d{3}).*$/, "$1-$2-$3");
            let ms = Date.now();
            while (existsSync(path.join(this.dir, `${name}.${stampOf(ms)}`))) ms++;
            const target = path.join(this.dir, `${name}.${stampOf(ms)}`);
            copyFileSync(file, target);
            chmodSync(target, 0o600);
            for (const old of this.list(name).slice(KEEP)) unlinkSync(path.join(this.dir, old.id));
            return target;
        } catch (err) {
            // Une sauvegarde ratée ne doit jamais empêcher l'enregistrement lui-même
            console.warn(`  sauvegarde de ${name} impossible : ${err.message}`);
            return null;
        }
    }

    /** Remet une copie à la place de file ; la version actuelle est d'abord sauvegardée (restauration réversible). */
    restore(file, id) {
        const name = path.basename(file);
        const copy = this.list(name).find((b) => b.id === id);
        if (!copy) throw new Error("sauvegarde introuvable");
        this.before(file, { force: true });
        copyFileSync(path.join(this.dir, copy.id), file);
        chmodSync(file, 0o600);
    }
}
