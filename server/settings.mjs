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
    /** Retour automatique à l'accueil après une action dans une rubrique (secondes, 0 = jamais). */
    autoHomeSeconds: {
        default: 60,
        clean(v) {
            const n = Number(v);
            if (!Number.isInteger(n) || n < 0 || n > 3600) throw new Error("délai de retour à l'accueil : nombre entier de 0 à 3600 secondes");
            return n;
        }
    }
};

export class Settings {
    constructor(file) {
        this.file = file;
        this.values = Object.fromEntries(Object.entries(SCHEMA).map(([k, s]) => [k, s.default]));
        if (!existsSync(file)) return;
        try {
            const saved = JSON.parse(readFileSync(file, "utf8"));
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

    /** Met à jour les réglages connus (tout ou rien) et les enregistre. */
    update(changes) {
        const next = { ...this.values };
        for (const [k, v] of Object.entries(changes ?? {})) {
            if (!SCHEMA[k]) continue;
            next[k] = SCHEMA[k].clean(v);
        }
        this.values = next;
        writeFileSync(this.file, `${JSON.stringify(this.values, null, 2)}\n`);
        return this.get();
    }
}
