// Traduction par dictionnaire (sans DOM) : utilisée par public/i18n.js et par les tests.

/**
 * Modèles compilés : « {0} VM(s) suivie(s) » -> /^(.+?) VM\(s\) suivie\(s\)$/ ; la valeur anglaise peut choisir le
 * singulier ou le pluriel : « {0:VM|VMs} » (singulier si la variable vaut 1).
 */
export function compile(dict) {
    const exact = new Map();
    const patterns = [];
    for (const [fr, en] of Object.entries(dict)) {
        if (!/\{\d\}/.test(fr)) { exact.set(fr, en); continue; }
        const source = fr.split(/(\{\d\})/).map((part) => (/^\{\d\}$/.test(part) ? "(.+?)" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("");
        const order = [...fr.matchAll(/\{(\d)\}/g)].map((m) => Number(m[1]));
        patterns.push({ re: new RegExp(`^${source}$`, "s"), order, en, literal: fr.replace(/\{\d\}/g, "").length });
    }
    // Les modèles les plus précis (plus de texte fixe) d'abord
    patterns.sort((a, b) => b.literal - a.literal);
    return { exact, patterns };
}

/** Remplit « {0} » et « {0:singulier|pluriel} » avec les valeurs capturées. */
function fill(en, values) {
    return en.replace(/\{(\d)(?::([^|}]*)\|([^}]*))?\}/g, (_, i, one, many) => {
        const v = values[Number(i)] ?? "";
        if (one === undefined) return v;
        return Number(String(v).replace(/\s/g, "")) === 1 ? one : many;
    });
}

/**
 * Traduit un texte français (espaces de bord conservés, espaces internes normalisés pour la recherche) ; les valeurs
 * capturées par un modèle sont elles-mêmes traduites si elles sont au dictionnaire (« Trier par : Nom » -> « Sort by:
 * Name ») ; inchangé s'il n'est pas dans le dictionnaire.
 */
export function translate(compiled, text, depth = 0) {
    const raw = String(text);
    const lead = /^\s*/.exec(raw)[0];
    const trail = /\s*$/.exec(raw)[0];
    const body = raw.slice(lead.length, raw.length - trail.length);
    if (!body) return raw;
    // Infobulle sur plusieurs lignes, puis texte HTML coupé sur plusieurs lignes, puis ligne par ligne
    const lines = body.replace(/[ \t]*\n[ \t]*/g, "\n").replace(/[ \t]+/g, " ");
    const hit = lookup(compiled, lines, depth) ?? lookup(compiled, lines.replace(/\s+/g, " "), depth)
        ?? (lines.includes("\n") ? lines.split("\n").map((l) => lookup(compiled, l, depth) ?? l).join("\n") : null);
    return hit === null || hit === lines ? raw : lead + hit + trail;
}

/** Traduction d'un texte déjà normalisé, ou null. */
function lookup(compiled, core, depth) {
    if (!core) return null;
    if (compiled.exact.has(core)) return compiled.exact.get(core);
    for (const p of compiled.patterns) {
        const m = p.re.exec(core);
        if (!m) continue;
        const values = [];
        p.order.forEach((index, k) => { values[index] = depth < 2 ? translate(compiled, m[k + 1], depth + 1) : m[k + 1]; });
        return fill(p.en, values);
    }
    return null;
}
