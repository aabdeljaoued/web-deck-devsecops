// Réglages modifiables depuis la page (espace "Réglages") : settings.json à la racine, exclu de Git.
// Chaque réglage a une valeur par défaut et une validation ; une valeur invalide du fichier est ignorée.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { normalizeEnv } from "./patches.mjs";
import { cleanNoProxy, cleanProxyUrl } from "./proxy.mjs";

/** Définition des réglages : défaut et validation (renvoie la valeur propre, ou lève une erreur lisible). */
const oneOf = (name, allowed) => (v) => {
    if (!allowed.includes(v)) throw new Error(`${name} : valeur inconnue "${v}" (possibles : ${allowed.map((a) => a || "aucun").join(", ")})`);
    return v;
};

/** Profil de mission : thème, rubriques et ordre, motif de production, dossier de travail, groupe de favoris. */
function cleanMission(m) {
    if (!m || typeof m !== "object") throw new Error("mission invalide");
    const id = String(m.id ?? "");
    if (!/^[a-z0-9-]{1,40}$/.test(id)) throw new Error("mission : identifiant invalide");
    const name = String(m.name ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40);
    if (!name) throw new Error("mission : le nom est obligatoire");
    const prodPattern = String(m.prodPattern ?? "").trim().slice(0, 100);
    try { new RegExp(prodPattern, "i"); } catch { throw new Error(`mission « ${name} » : motif de production invalide (${prodPattern})`); }
    return {
        id,
        name,
        theme: SCHEMA.missionTheme.clean(m.theme ?? ""),
        worlds: SCHEMA.worlds.clean(m.worlds ?? {}),
        worldOrder: SCHEMA.worldOrder.clean(m.worldOrder ?? []),
        prodPattern,
        workspace: String(m.workspace ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 300),
        favGroup: /^[0-9a-f-]{0,64}$/i.test(String(m.favGroup ?? "")) ? String(m.favGroup ?? "") : "",
        vars: cleanVars(m.vars ?? {}, name),
        certs: cleanCerts(m.certs ?? [], name)
    };
}

/** Certificats surveillés : « hôte » ou « hôte:port » (443 par défaut), 20 au plus. */
/**
 * Certificats surveillés : { target: « hôte » ou « hôte:port » (443 par défaut), env } ; 20 au plus.
 * Ancien format (texte seul) ou environnement absent : production (rien n'échappe à la surveillance la plus stricte).
 */
function cleanCerts(v, mission) {
    if (!Array.isArray(v) || v.length > 20) throw new Error(`mission « ${mission} » : 20 certificats au plus`);
    const seen = new Set();
    const out = [];
    for (const item of v) {
        const raw = typeof item === "string" ? { target: item } : item ?? {};
        const target = String(raw.target ?? "").trim().toLowerCase();
        if (!target || seen.has(target)) continue;
        if (!/^[a-z0-9]([a-z0-9.-]{0,252}[a-z0-9])?(:\d{1,5})?$/.test(target)) throw new Error(`mission « ${mission} » : certificat « ${target} » invalide (hôte ou hôte:port)`);
        const port = Number(target.split(":")[1] ?? 443);
        if (port < 1 || port > 65535) throw new Error(`mission « ${mission} » : port invalide pour ${target}`);
        const env = raw.env == null || String(raw.env).trim() === "" ? "production" : normalizeEnv(raw.env);
        if (!env) throw new Error(`mission « ${mission} » : environnement inconnu « ${raw.env} » pour ${target} (production, recette, qualification, développement, autre)`);
        seen.add(target);
        out.push({ target, env });
    }
    return out;
}

/** Variables d'une mission ({mission.nom} dans les commandes) : 30 au plus, valeurs sur une ligne. */
function cleanVars(v, mission) {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`mission « ${mission} » : variables invalides`);
    const entries = Object.entries(v);
    if (entries.length > 30) throw new Error(`mission « ${mission} » : 30 variables au plus`);
    const out = {};
    for (const [k, val] of entries) {
        if (!/^[A-Za-z][A-Za-z0-9_-]{0,30}$/.test(k)) throw new Error(`mission « ${mission} » : nom de variable invalide « ${k} » (lettres, chiffres, - et _)`);
        const value = String(val ?? "");
        if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`mission « ${mission} » : la variable ${k} doit tenir sur une ligne`);
        if (value.length > 500) throw new Error(`mission « ${mission} » : variable ${k} trop longue (500 caractères au plus)`);
        out[k] = value.trim();
    }
    return out;
}

const SCHEMA = {
    /** Profils de mission (20 au plus) et mission active ("" = aucune). */
    missions: {
        default: [],
        clean(v) {
            if (!Array.isArray(v) || v.length > 20) throw new Error("missions : 20 au plus");
            const list = v.map(cleanMission);
            if (new Set(list.map((m) => m.id)).size !== list.length) throw new Error("missions : identifiants en double");
            return list;
        }
    },
    activeMission: {
        default: "",
        clean(v) {
            if (typeof v !== "string" || !/^[a-z0-9-]{0,40}$/.test(v)) throw new Error("mission active invalide");
            return v;
        }
    },
    /** Journal des actions lancées depuis le deck (Réglages › Journal). */
    journalEnabled: {
        default: true,
        clean(v) {
            if (typeof v !== "boolean") throw new Error("journal : activé (true) ou non (false)");
            return v;
        }
    },
    /**
     * Proxy de sortie (Réglages › Proxy) : mode system (variables d'environnement), auto (actif s'il répond),
     * on, off ; adresse et NO_PROXY (vides = ceux des variables d'environnement).
     */
    proxy: {
        default: { mode: "system", url: "", noProxy: "" },
        clean(v) {
            if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("proxy : objet { mode, url, noProxy } attendu");
            if (!["system", "auto", "on", "off"].includes(v.mode)) throw new Error("proxy : mode system, auto, on ou off");
            return { mode: v.mode, url: cleanProxyUrl(v.url), noProxy: cleanNoProxy(v.noProxy) };
        }
    },
    /** Mode d'affichage : sombre, clair, ou celui du système. */
    appearance: { default: "dark", clean: oneOf("mode d'affichage", ["dark", "light", "system"]) },
    /** Langue de l'interface : français ou anglais (public/i18n.js). */
    language: { default: "fr", clean: oneOf("langue", ["fr", "en"]) },
    /** Signature en filigrane au fond des terminaux ("" = aucune). */
    watermark: {
        default: "",
        clean(v) {
            if (typeof v !== "string") throw new Error("signature : texte attendu");
            return v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 60);
        }
    },
    /** Style de la signature : texte simple ou bannière ASCII (FIGlet), et police de la bannière. */
    watermarkStyle: { default: "text", clean: oneOf("style de signature", ["text", "ascii"]) },
    watermarkFont: { default: "ANSI Shadow", clean: oneOf("police de bannière", ["ANSI Shadow", "Standard", "Slant", "Big", "Small", "Doom", "Banner3", "Block"]) },
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
    /** Ordre des rubriques sur l'accueil ([] = celui de config.jsonc) : identifiants, les absents à la suite. */
    worldOrder: {
        default: [],
        clean(v) {
            if (!Array.isArray(v) || v.length > 60 || !v.every((id) => typeof id === "string" && /^[a-z0-9_-]{1,40}$/i.test(id))) {
                throw new Error("ordre des rubriques : liste d'identifiants attendue");
            }
            return [...new Set(v)];
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
