// Réglages modifiables depuis la page (espace "Réglages") : settings.json à la racine, exclu de Git.
// Chaque réglage a une valeur par défaut et une validation ; une valeur invalide du fichier est ignorée.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/** Définition des réglages : défaut et validation (renvoie la valeur propre, ou lève une erreur lisible). */
const oneOf = (name, allowed) => (v) => {
    if (!allowed.includes(v)) throw new Error(`${name} : valeur inconnue "${v}" (possibles : ${allowed.map((a) => a || "aucun").join(", ")})`);
    return v;
};

const SCHEMA = {
    /** Mode d'affichage : sombre, clair, ou celui du système. */
    appearance: { default: "dark", clean: oneOf("mode d'affichage", ["dark", "light", "system"]) },
    /** Thème aux couleurs d'une mission ("" = aucun). */
    missionTheme: { default: "", clean: oneOf("thème de mission", ["", "allianz", "bnp", "estreem", "laposte"]) },
    /** Retour automatique à l'accueil après une action dans une rubrique : activé ou non, et délai. */
    autoHomeEnabled: {
        default: true,
        clean(v) {
            if (typeof v !== "boolean") throw new Error("retour automatique à l'accueil : activé (true) ou non (false)");
            return v;
        }
    },
    /** Rubriques activées ou non, en écart avec config.jsonc : { "<id>": true | false }. */
    worlds: {
        default: {},
        clean(v) {
            if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("rubriques : objet { identifiant: true | false } attendu");
            const entries = Object.entries(v);
            if (entries.length > 60) throw new Error("rubriques : 60 au plus");
            for (const [id, on] of entries) {
                if (!/^[a-z0-9_-]{1,40}$/i.test(id) || typeof on !== "boolean") throw new Error(`rubriques : entrée invalide "${id}"`);
            }
            return Object.fromEntries(entries);
        }
    },
    autoHomeSeconds: {
        default: 60,
        clean(v) {
            const n = Number(v);
            if (!Number.isInteger(n) || n < 5 || n > 3600) throw new Error("délai de retour à l'accueil : nombre entier de 5 à 3600 secondes");
            return n;
        }
    }
};

export class Settings {
    /** @param backups sauvegardes automatiques (server/backups.mjs), facultatif */
    constructor(file, backups = null) {
        this.file = file;
        this.backups = backups;
        this.reload();
    }

    /** (Re)lit settings.json (démarrage, restauration d'une sauvegarde). */
    reload() {
        const file = this.file;
        this.values = Object.fromEntries(Object.entries(SCHEMA).map(([k, s]) => [k, s.default]));
        if (!existsSync(file)) return;
        try {
            const saved = JSON.parse(readFileSync(file, "utf8"));
            // Ancien format : délai 0 = désactivé (le délai par défaut est gardé pour une future réactivation)
            if (saved.autoHomeSeconds === 0 && !("autoHomeEnabled" in saved)) {
                saved.autoHomeEnabled = false;
                delete saved.autoHomeSeconds;
            }
            for (const [k, s] of Object.entries(SCHEMA)) {
                if (!(k in saved)) continue;
                try { this.values[k] = s.clean(saved[k]); } catch (err) { console.warn(`  settings.json : ${err.message} (valeur par défaut gardée)`); }
            }
        } catch (err) {
            console.warn(`  settings.json illisible : ${err.message}`);
        }
    }

    get() {
        return { ...this.values };
    }

    /** Réglages après ces changements (vérifiés, tout ou rien), sans les enregistrer. */
    check(changes) {
        const next = { ...this.values };
        for (const [k, v] of Object.entries(changes ?? {})) {
            if (!SCHEMA[k]) continue;
            next[k] = SCHEMA[k].clean(v);
        }
        return next;
    }

    /** Enregistre des réglages déjà vérifiés par check(). */
    save(next) {
        this.backups?.before(this.file);
        this.values = next;
        writeFileSync(this.file, `${JSON.stringify(this.values, null, 2)}\n`);
        return this.get();
    }

    /** Met à jour les réglages connus (tout ou rien) et les enregistre. */
    update(changes) {
        return this.save(this.check(changes));
    }
}
