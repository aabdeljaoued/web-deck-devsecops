// Favoris : sites liés à la mission, ajoutés depuis le deck (rubrique "favoris").
// Enregistrés dans favoris.json, exclu de Git : les adresses internes ne partent pas sur le dépôt.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { iconFile } from "./icons.mjs";

/** Touches de la rubrique : 14 au plus, moins Ajouter et Modifier (Retour est en plus). */
export const MAX_FAVORITES = 12;

/** Services connus par leur nom de domaine (le reste est deviné d'après les parties du nom d'hôte). */
const KNOWN_HOSTS = [
    [/(^|\.)github\.com$/, "github"],
    [/(^|\.)gitlab\./, "gitlab"],
    [/(^|\.)bitbucket\./, "bitbucket"],
    [/(^|\.)dev\.azure\.com$|visualstudio\.com$/, "lucide-cloud"],
    [/(^|\.)cloud\.google\.com$/, "googlecloud"],
    [/(^|\.)aws\.amazon\.com$/, "lucide-cloud"],
    [/(^|\.)sonarcloud\.io$|(^|[.-])sonar/, "lucide-scan-search"],
    [/(^|[.-])argo(cd)?([.-]|$)/, "argo"],
    [/(^|[.-])nexus([.-]|$)/, "sonatype"],
    [/(^|[.-])artifactory([.-]|$)|jfrog/, "jfrog"],
    [/(^|[.-])(openshift|ocp|console-openshift)/, "redhat"],
    [/(^|[.-])(k8s|kube|kubernetes)([.-]|$)/, "kubernetes"]
];
const IGNORED = new Set(["www", "com", "fr", "io", "net", "org", "eu", "dev", "app", "cloud", "local", "internal", "intra", "corp", "lan", "prod", "preprod", "staging", "test", "recette"]);

/** Icône d'un favori : celle choisie si elle existe, sinon devinée d'après l'adresse, sinon un globe. */
export function iconForUrl(url, chosen) {
    if (chosen && iconFile(chosen)) return chosen;
    let host;
    let pathname = "";
    try {
        ({ hostname: host, pathname } = new URL(url));
    } catch {
        return "lucide-globe";
    }
    host = host.toLowerCase();
    // Atlassian : Confluence (/wiki) ou Jira
    if (/atlassian\.net$|(^|[.-])(jira|confluence)([.-]|$)/.test(host)) {
        return /\/wiki(\/|$)/.test(pathname) || /confluence/.test(host) ? "confluence" : "jira";
    }
    for (const [re, icon] of KNOWN_HOSTS) if (re.test(host) && iconFile(icon)) return icon;
    for (const part of host.split(/[.-]/)) {
        if (part.length < 3 || IGNORED.has(part) || /^\d+$/.test(part)) continue;
        if (iconFile(part)) return part;
    }
    return "lucide-globe";
}

function clean(def) {
    const label = String(def?.label ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 30);
    if (!label) throw new Error("le nom est obligatoire");
    let url = String(def?.url ?? "").trim();
    if (url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `https://${url}`;   // "grafana.mission.fr" -> https://
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error("adresse invalide"); }
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("seules les adresses http:// et https:// sont acceptées");
    const icon = typeof def?.icon === "string" && def.icon.trim() ? def.icon.trim().toLowerCase() : null;
    if (icon && !iconFile(icon)) throw new Error(`icône introuvable : ${icon} (ex. "lucide-book", "github", ou vide pour automatique)`);
    return { label, url: parsed.href, icon };
}

export class Favorites {
    constructor(file) {
        this.file = file;
        this.items = [];
        if (!existsSync(file)) return;
        try {
            const data = JSON.parse(readFileSync(file, "utf8"));
            for (const def of Array.isArray(data) ? data : []) {
                try {
                    this.items.push({ id: typeof def.id === "string" ? def.id : randomUUID(), ...clean(def) });
                } catch (err) {
                    console.warn(`  favoris.json : "${def?.label ?? "?"}" ignoré (${err.message})`);
                }
            }
            this.items = this.items.slice(0, MAX_FAVORITES);
        } catch (err) {
            console.warn(`  favoris.json illisible : ${err.message}`);
        }
    }

    /** Favoris avec leur icône affichée (choisie ou automatique) ; chosen = icône choisie par l'utilisateur. */
    list() {
        return this.items.map((f) => ({ ...f, chosen: f.icon, icon: iconForUrl(f.url, f.icon) }));
    }

    add(def) {
        if (this.items.length >= MAX_FAVORITES) throw new Error(`${MAX_FAVORITES} favoris au maximum : supprime-en un d'abord`);
        this.items.push({ id: randomUUID(), ...clean(def) });
        this.save();
    }

    update(id, def) {
        const i = this.items.findIndex((f) => f.id === id);
        if (i < 0) throw new Error("favori introuvable");
        this.items[i] = { id, ...clean(def) };
        this.save();
    }

    remove(id) {
        const before = this.items.length;
        this.items = this.items.filter((f) => f.id !== id);
        if (this.items.length === before) throw new Error("favori introuvable");
        this.save();
    }

    /** Déplace un favori d'une place vers la gauche (-1) ou la droite (+1). */
    move(id, delta) {
        const i = this.items.findIndex((f) => f.id === id);
        const j = i + Math.sign(Number(delta) || 0);
        if (i < 0 || j < 0 || j >= this.items.length) return;
        [this.items[i], this.items[j]] = [this.items[j], this.items[i]];
        this.save();
    }

    save() {
        const data = this.items.map(({ id, label, url, icon }) => ({ id, label, url, ...(icon ? { icon } : {}) }));
        writeFileSync(this.file, `${JSON.stringify(data, null, 2)}\n`);
    }
}
