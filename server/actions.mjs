// Mes actions : rubriques et touches créées depuis le deck (Réglages › Mes actions), sans éditer config.jsonc.
// Enregistrées dans actions.json (exclu de Git : les commandes propres à un client ne partent pas sur le dépôt),
// sauvegardé comme les favoris. Chaque rubrique devient un monde de l'accueil (identifiant "u-…").
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { iconFile } from "./icons.mjs";

/** Touches d'une rubrique : 16 au plus (Retour et clear en plus, voir SECTION_MAX du catalogue). */
export const MAX_ACTIONS = 16;
export const MAX_SECTIONS = 10;

const newId = (prefix) => `${prefix}-${randomBytes(4).toString("hex")}`;
const text = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);

function cleanIcon(v) {
    const icon = text(v, 60).toLowerCase();
    if (icon && !iconFile(icon)) throw new Error(`icône introuvable : ${icon} (ex. "lucide-rocket" sur lucide.dev/icons, ou un logo comme "github")`);
    return icon || null;
}

function cleanColor(v, fallback) {
    const c = text(v, 7).toLowerCase();
    if (!c) return fallback;
    if (!/^#[0-9a-f]{6}$/.test(c)) throw new Error(`couleur invalide : ${c} (format #rrggbb)`);
    return c;
}

function cleanSection(def, id) {
    const label = text(def?.label, 30);
    if (!label) throw new Error("le nom de la rubrique est obligatoire");
    return { id, label, icon: cleanIcon(def?.icon) ?? "lucide-star", color: cleanColor(def?.color, "#607d8b") };
}

/** Action : commande (exécutée ou à compléter, {} = texte sélectionné) ou lien http(s). */
function cleanAction(def, id) {
    const label = text(def?.label, 30);
    if (!label) throw new Error("le nom de l'action est obligatoire");
    const action = { id, label, icon: cleanIcon(def?.icon), description: text(def?.description, 120) || null, pinned: def?.pinned === true };
    if (def?.kind === "url") {
        let url = text(def?.url, 500);
        if (url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `https://${url}`;
        let parsed;
        try { parsed = new URL(url); } catch { throw new Error("adresse invalide"); }
        if (!/^https?:$/.test(parsed.protocol)) throw new Error("seules les adresses http:// et https:// sont acceptées");
        return { ...action, kind: "url", url: parsed.href };
    }
    // Une commande tient sur une ligne : un retour à la ligne la lancerait avant qu'on la relise
    const command = String(def?.command ?? "").trim();
    if (!command) throw new Error("la commande est obligatoire");
    if (/[\r\n]/.test(command)) throw new Error("la commande doit tenir sur une ligne");
    if (command.length > 500) throw new Error("commande trop longue (500 caractères au plus)");
    if (/[\u0000-\u001f\u007f]/.test(command)) throw new Error("la commande contient un caractère de contrôle");
    return { ...action, kind: "command", command, enter: def?.enter === true && !command.includes("{}") };
}

export class Actions {
    /** @param backups sauvegardes automatiques (server/backups.mjs), facultatif */
    constructor(file, backups = null) {
        this.file = file;
        this.backups = backups;
        this.reload();
    }

    /** (Re)lit actions.json ; une entrée invalide est ignorée avec un avertissement. */
    reload() {
        this.sections = [];
        if (!existsSync(this.file)) return;
        try {
            const data = JSON.parse(readFileSync(this.file, "utf8"));
            for (const s of Array.isArray(data?.sections) ? data.sections.slice(0, MAX_SECTIONS) : []) {
                try {
                    const section = cleanSection(s, /^u-[0-9a-f]{8}$/.test(s?.id) ? s.id : newId("u"));
                    section.actions = [];
                    for (const a of Array.isArray(s.actions) ? s.actions.slice(0, MAX_ACTIONS) : []) {
                        try { section.actions.push(cleanAction(a, /^a-[0-9a-f]{8}$/.test(a?.id) ? a.id : newId("a"))); } catch (err) { console.warn(`  actions.json : action « ${a?.label ?? "?"} » ignorée (${err.message})`); }
                    }
                    this.sections.push(section);
                } catch (err) {
                    console.warn(`  actions.json : rubrique « ${s?.label ?? "?"} » ignorée (${err.message})`);
                }
            }
        } catch (err) {
            console.warn(`  actions.json illisible : ${err.message}`);
        }
    }

    list() {
        return structuredClone(this.sections);
    }

    section(id) {
        const s = this.sections.find((x) => x.id === id);
        if (!s) throw new Error("rubrique introuvable");
        return s;
    }

    /** Création (sans id) ou modification d'une rubrique ; renvoie son identifiant. */
    saveSection(def) {
        if (def?.id) {
            const s = this.section(String(def.id));
            Object.assign(s, cleanSection(def, s.id));
        } else {
            if (this.sections.length >= MAX_SECTIONS) throw new Error(`${MAX_SECTIONS} rubriques au plus`);
            this.sections.push({ ...cleanSection(def, newId("u")), actions: [] });
        }
        this.save();
        return def?.id ?? this.sections.at(-1).id;
    }

    /**
     * Rubrique reçue d'un collègue (fichier exporté depuis un autre deck) : tout est revalidé comme une saisie,
     * nouveaux identifiants, rien d'épinglé sur l'accueil. Renvoie l'identifiant de la rubrique créée.
     */
    importSection(def) {
        if (this.sections.length >= MAX_SECTIONS) throw new Error(`${MAX_SECTIONS} rubriques au plus`);
        if (!Array.isArray(def?.actions)) throw new Error("fichier invalide : aucune liste d'actions");
        if (def.actions.length > MAX_ACTIONS) throw new Error(`${MAX_ACTIONS} actions au plus par rubrique (le fichier en contient ${def.actions.length})`);
        const section = cleanSection(def, newId("u"));
        if (this.sections.some((s) => s.label === section.label)) section.label = `${section.label} (importée)`.slice(0, 30);
        const actions = def.actions.map((a, i) => {
            try { return cleanAction({ ...a, pinned: false }, newId("a")); }
            catch (err) { throw new Error(`action ${i + 1} (${text(a?.label, 30) || "sans nom"}) : ${err.message}`); }
        });
        this.sections.push({ ...section, actions });
        this.save();
        return section.id;
    }

    deleteSection(id) {
        this.section(String(id));
        this.sections = this.sections.filter((s) => s.id !== id);
        this.save();
    }

    /** Création (sans id) ou modification d'une action dans une rubrique. */
    saveAction(sectionId, def) {
        const s = this.section(String(sectionId));
        if (def?.id) {
            const i = s.actions.findIndex((a) => a.id === def.id);
            if (i < 0) throw new Error("action introuvable");
            s.actions[i] = cleanAction(def, s.actions[i].id);
        } else {
            if (s.actions.length >= MAX_ACTIONS) throw new Error(`${MAX_ACTIONS} actions au plus par rubrique`);
            s.actions.push(cleanAction(def, newId("a")));
        }
        this.save();
    }

    deleteAction(sectionId, id) {
        const s = this.section(String(sectionId));
        s.actions = s.actions.filter((a) => a.id !== id);
        this.save();
    }

    /** Déplace une action d'une place vers la gauche (-1) ou la droite (+1). */
    moveAction(sectionId, id, delta) {
        const s = this.section(String(sectionId));
        const i = s.actions.findIndex((a) => a.id === id);
        const j = i + Math.sign(Number(delta) || 0);
        if (i < 0 || j < 0 || j >= s.actions.length) return;
        [s.actions[i], s.actions[j]] = [s.actions[j], s.actions[i]];
        this.save();
    }

    save() {
        this.backups?.before(this.file);
        writeFileSync(this.file, `${JSON.stringify({ sections: this.sections }, null, 2)}\n`);
    }
}
