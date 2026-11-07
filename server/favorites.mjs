// Favoris : sites liés à la mission, ajoutés depuis le deck (rubrique "favoris").
// Enregistrés dans favoris.json, exclu de Git : les adresses internes ne partent pas sur le dépôt.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { iconFile } from "./icons.mjs";

/** Éléments par niveau (sites et groupes) : 14 touches au plus, moins Ajouter et Modifier (Retour est en plus). */
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

function cleanLabel(def) {
    const label = String(def?.label ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 30);
    if (!label) throw new Error("le nom est obligatoire");
    return label;
}

function cleanIcon(def) {
    const icon = typeof def?.icon === "string" && def.icon.trim() ? def.icon.trim().toLowerCase() : null;
    if (icon && !iconFile(icon)) throw new Error(`icône introuvable : ${icon} (ex. "lucide-book", "github", ou vide pour automatique)`);
    return icon;
}

/** Site : nom, adresse http(s) et icône facultative. */
function cleanSite(def) {
    let url = String(def?.url ?? "").trim();
    if (url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `https://${url}`;   // "grafana.mission.fr" -> https://
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error("adresse invalide"); }
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("seules les adresses http:// et https:// sont acceptées");
    return { label: cleanLabel(def), url: parsed.href, icon: cleanIcon(def) };
}

/** Couleur d'un groupe : "#rrggbb", ou null (couleur par défaut des favoris). */
function cleanColor(def) {
    const color = typeof def?.color === "string" ? def.color.trim().toLowerCase() : "";
    if (!color) return null;
    if (!/^#[0-9a-f]{6}$/.test(color)) throw new Error(`couleur invalide : ${color} (format #rrggbb)`);
    return color;
}

/** Groupe : nom, icône et couleur facultatives, et contenu. */
function cleanGroup(def) {
    return { type: "group", label: cleanLabel(def), icon: cleanIcon(def), color: cleanColor(def) };
}

/** Profondeur maximale : groupes à la racine, sous-groupes dedans ; un sous-groupe ne contient que des sites. */
export const MAX_GROUP_DEPTH = 2;

/**
 * Arbre des favoris : sites { id, label, url, icon } et groupes { id, type: "group", label, icon, items: [...] }.
 * Racine = rubrique Favoris (profondeur 0) ; groupes en profondeur 1, sous-groupes en profondeur 2.
 */
export class Favorites {
    constructor(file) {
        this.file = file;
        this.items = [];
        if (!existsSync(file)) return;
        try {
            const data = JSON.parse(readFileSync(file, "utf8"));
            this.items = this.load(Array.isArray(data) ? data : [], 0);
        } catch (err) {
            console.warn(`  favoris.json illisible : ${err.message}`);
        }
    }

    load(list, depth, stats = null) {
        const items = [];
        for (const def of list) {
            try {
                const id = typeof def?.id === "string" ? def.id : randomUUID();
                if (def?.type === "group") {
                    if (depth >= MAX_GROUP_DEPTH) throw new Error("trop de niveaux de groupes");
                    items.push({ id, ...cleanGroup(def), items: this.load(Array.isArray(def.items) ? def.items : [], depth + 1, stats) });
                } else {
                    items.push({ id, ...cleanSite(def) });   // ancien format (liste de sites) accepté tel quel
                }
            } catch (err) {
                if (stats) stats.skipped.push(`"${def?.label ?? "?"}" : ${err.message}`);
                else console.warn(`  favoris.json : "${def?.label ?? "?"}" ignoré (${err.message})`);
            }
        }
        if (stats && items.length > MAX_FAVORITES) stats.skipped.push(`${items.length - MAX_FAVORITES} élément(s) au-delà de ${MAX_FAVORITES} par niveau`);
        return items.slice(0, MAX_FAVORITES);
    }

    /** Contenu enregistrable (format de favoris.json) : icônes choisies seulement. */
    dump(items = this.items) {
        return items.map((f) => f.type === "group"
            ? { id: f.id, type: "group", label: f.label, ...(f.icon ? { icon: f.icon } : {}), ...(f.color ? { color: f.color } : {}), items: this.dump(f.items) }
            : { id: f.id, label: f.label, url: f.url, ...(f.icon ? { icon: f.icon } : {}) });
    }

    /** Fichier d'export : favoris et quelques informations pour le reconnaître à l'import. */
    export() {
        return { app: "web-deck-devsecops", kind: "favoris", version: 1, exported: new Date().toISOString(), favorites: this.dump() };
    }

    /**
     * Import d'un export (ou d'un favoris.json) : "replace" remplace tout, "merge" ajoute ce qui manque
     * (groupes de même nom fusionnés, sites déjà présents à la même place ignorés). Tout ou rien.
     */
    import(data, mode = "merge") {
        const list = Array.isArray(data) ? data : data?.kind === "favoris" && Array.isArray(data.favorites) ? data.favorites : null;
        if (!list) throw new Error("fichier non reconnu : ce n'est pas un export de favoris du deck");
        const stats = { added: 0, duplicates: 0, skipped: [] };
        const incoming = this.load(list, 0, stats);
        const sites = (items) => items.reduce((n, f) => n + (f.type === "group" ? sites(f.items) : 1), 0);
        if (mode === "replace") {
            this.items = incoming;
            stats.added = sites(incoming);
        } else if (mode === "merge") {
            const fresh = (f) => ({ ...f, id: randomUUID(), ...(f.type === "group" ? { items: f.items.map(fresh) } : {}) });
            const merge = (target, items, depth) => {
                for (const f of items) {
                    if (f.type === "group") {
                        const same = target.find((g) => g.type === "group" && g.label.toLowerCase() === f.label.toLowerCase());
                        if (same) { merge(same.items, f.items, depth + 1); continue; }
                    } else if (target.some((s) => s.type !== "group" && s.url === f.url)) {
                        stats.duplicates++;
                        continue;
                    }
                    if (target.length >= MAX_FAVORITES) throw new Error(`fusion impossible : plus de ${MAX_FAVORITES} éléments à un même niveau ("${f.label}")`);
                    target.push(fresh(f));
                    stats.added += f.type === "group" ? sites(f.items) : 1;
                }
            };
            const next = structuredClone(this.items);
            merge(next, incoming, 0);
            this.items = next;
        } else {
            throw new Error(`mode d'import inconnu : ${mode}`);
        }
        this.save();
        return stats;
    }

    /** Arbre avec les icônes affichées (choisie, automatique pour un site, dossier pour un groupe) ; chosen = icône choisie. */
    list(items = this.items) {
        return items.map((f) => f.type === "group"
            ? { ...f, chosen: f.icon, icon: f.icon ?? "lucide-folder", items: this.list(f.items) }
            : { ...f, chosen: f.icon, icon: iconForUrl(f.url, f.icon) });
    }

    /** Groupes (pour le choix « Dans ») : id, chemin et profondeur, dans l'ordre d'affichage. */
    groups(items = this.items, depth = 1, path = []) {
        return items.filter((f) => f.type === "group").flatMap((g) => [
            { id: g.id, label: g.label, path: [...path, g.label].join(" › "), depth },
            ...this.groups(g.items, depth + 1, [...path, g.label])
        ]);
    }

    /** Élément et son contenant (liste), profondeur du contenant (0 = racine). */
    find(id, items = this.items, depth = 0, parentId = null) {
        for (const f of items) {
            if (f.id === id) return { node: f, list: items, depth, parentId };
            if (f.type === "group") {
                const found = this.find(id, f.items, depth + 1, f.id);
                if (found) return found;
            }
        }
        return null;
    }

    /** Liste d'un contenant (null = racine) et sa profondeur. */
    container(parentId) {
        if (parentId == null || parentId === "") return { list: this.items, depth: 0 };
        const found = this.find(String(parentId));
        if (!found || found.node.type !== "group") throw new Error("groupe introuvable");
        return { list: found.node.items, depth: found.depth + 1 };
    }

    static count(node) {
        return node.type === "group" ? 1 + node.items.reduce((n, f) => n + Favorites.count(f), 0) : 1;
    }

    static groupHeight(node) {
        return node.type === "group" ? 1 + Math.max(0, ...node.items.map(Favorites.groupHeight)) : 0;
    }

    /** Vérifie qu'un élément peut aller dans ce contenant (place, niveaux de groupes). */
    checkFits(node, target, movingWithin = false) {
        if (!movingWithin && target.list.length >= MAX_FAVORITES) throw new Error(`${MAX_FAVORITES} éléments au maximum par niveau`);
        if (target.depth + Favorites.groupHeight(node) > MAX_GROUP_DEPTH) {
            throw new Error(node.type === "group" && target.depth > 0
                ? (Favorites.groupHeight(node) > 1 ? "un groupe qui contient des sous-groupes reste à la racine des favoris" : "un sous-groupe ne peut pas contenir de groupe")
                : "trop de niveaux de groupes");
        }
    }

    /** Ajout d'un site (kind "site") ou d'un groupe (kind "group") dans un contenant (parent null = racine). */
    add(def) {
        const node = def?.kind === "group" ? { id: randomUUID(), ...cleanGroup(def), items: [] } : { id: randomUUID(), ...cleanSite(def) };
        const target = this.container(def?.parent);
        this.checkFits(node, target);
        target.list.push(node);
        this.save();
    }

    /** Modification (nom, adresse, icône) et éventuellement changement de groupe (parent). */
    update(id, def) {
        const found = this.find(id);
        if (!found) throw new Error("favori introuvable");
        const { node } = found;
        Object.assign(node, node.type === "group" ? { ...cleanGroup(def), items: node.items } : cleanSite(def));
        if (def && "parent" in def && (def.parent || null) !== found.parentId) {
            const target = this.container(def.parent);
            if (node.type === "group" && (def.parent === node.id || this.find(String(def.parent), node.items))) {
                throw new Error("un groupe ne peut pas aller dans lui-même");
            }
            this.checkFits(node, target);
            found.list.splice(found.list.indexOf(node), 1);
            target.list.push(node);
        }
        this.save();
    }

    remove(id) {
        const found = this.find(id);
        if (!found) throw new Error("favori introuvable");
        found.list.splice(found.list.indexOf(found.node), 1);
        this.save();
    }

    /**
     * Glisser-déposer : place un élément dans un contenant (parent null = racine), avant l'élément "before"
     * (null = à la fin). Sert à réordonner, à entrer dans un groupe et à remonter d'un niveau.
     */
    place(id, parent, before) {
        const found = this.find(id);
        if (!found) throw new Error("favori introuvable");
        const { node } = found;
        const target = this.container(parent);
        if (node.type === "group" && parent != null && (String(parent) === node.id || this.find(String(parent), node.items))) {
            throw new Error("un groupe ne peut pas aller dans lui-même");
        }
        const sameList = target.list === found.list;
        if (!sameList) this.checkFits(node, target);
        found.list.splice(found.list.indexOf(node), 1);
        const at = before == null ? -1 : target.list.findIndex((f) => f.id === String(before));
        target.list.splice(at < 0 ? target.list.length : at, 0, node);
        this.save();
    }

    /** Déplace un élément d'une place vers la gauche (-1) ou la droite (+1) dans son contenant. */
    move(id, delta) {
        const found = this.find(id);
        if (!found) return;
        const i = found.list.indexOf(found.node);
        const j = i + Math.sign(Number(delta) || 0);
        if (j < 0 || j >= found.list.length) return;
        [found.list[i], found.list[j]] = [found.list[j], found.list[i]];
        this.save();
    }

    save() {
        writeFileSync(this.file, `${JSON.stringify(this.dump(), null, 2)}\n`);
    }
}
