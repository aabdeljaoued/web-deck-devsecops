// Tableau de bord des patchs : ordre de patch proposé et points de vigilance, calculés à partir de l'inventaire
// (sans DOM : utilisé par public/app.js et par les tests). Textes en français, traduits à l'affichage (public/i18n.js).

/** Ordre des environnements dans une campagne : la recette avant la production. */
export const ENV_RANK = { "développement": 0, qualification: 1, recette: 2, autre: 3, production: 4 };
const envRank = (env) => ENV_RANK[env] ?? 3;

const DAY = 86400000;
const utcDay = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
/** Jours jusqu'à la date AAAA-MM-JJ (négatif = en retard), null sans date. */
export const daysUntil = (day, today = new Date()) => (day ? Math.round((Date.parse(`${day}T00:00:00Z`) - utcDay(today)) / DAY) : null);
/** AAAA-MM-JJ -> JJ/MM/AAAA. */
export const frDay = (day) => (day ? day.split("-").reverse().join("/") : "");
const byName = (a, b) => a.name.localeCompare(b.name, "fr", { numeric: true });
const live = (vms) => vms.filter((v) => !v.decommissioned);

/** Nœuds suivis de chaque cluster : nom -> VMs. */
function clusterNodes(vms) {
    const map = new Map();
    for (const v of live(vms)) if (v.cluster) map.set(v.cluster, [...(map.get(v.cluster) ?? []), v]);
    return map;
}

/**
 * Ordre de patch proposé pour les VMs en retard, dues dans `horizon` jours ou avec de la sécurité en attente :
 * - un groupe par cluster concerné (tous ses nœuds suivis : ils se patchent ensemble), un groupe par VM seule ;
 * - dans un cluster : les SECONDARY d'abord, un nœud à la fois, puis bascule du PRIMARY vers un nœud déjà patché,
 *   et l'ancien PRIMARY en dernier ;
 * - les groupes rangés par environnement (développement, qualification, recette, autre, production), puis par urgence.
 */
export function patchPlan(vms, { today = new Date(), horizon = 7 } = {}) {
    const days = (v) => daysUntil(v.nextPatch, today);
    // Due : en retard, dans l'horizon, ou avec des mises à jour de sécurité en attente (relevé fait sur la VM)
    const due = (v) => (days(v) !== null && days(v) <= horizon) || (v.check?.security ?? 0) > 0;
    const groups = [];
    for (const [cluster, nodes] of clusterNodes(vms)) {
        if (!nodes.some(due)) continue;
        const primary = nodes.find((v) => v.role === "primary") ?? null;
        const secondaries = nodes.filter((v) => v !== primary).sort((a, b) => (days(a) ?? 1e6) - (days(b) ?? 1e6) || byName(a, b));
        const step = (v, note = "") => ({ kind: "patch", vm: v.name, role: v.role ?? "", days: days(v), due: due(v), security: v.check?.security ?? 0, note });
        const steps = secondaries.map((v) => step(v));
        if (primary) {
            if (secondaries.length) steps.push({ kind: "switch", from: primary.name, to: secondaries[0].name });
            steps.push(step(primary, secondaries.length ? "ancien PRIMARY" : ""));
        }
        groups.push({
            env: nodes[0].env, cluster, vms: nodes.map((v) => v.name),
            urgency: Math.min(...nodes.filter(due).map((v) => days(v) ?? horizon)),
            warning: !primary && nodes.length > 1 ? "PRIMARY non renseigné : vérifie-le (cluster status) avant de commencer" : "",
            steps
        });
    }
    for (const v of live(vms).filter((x) => !x.cluster && due(x))) {
        groups.push({ env: v.env, cluster: null, vms: [v.name], urgency: days(v), warning: "", steps: [{ kind: "patch", vm: v.name, role: "", days: days(v), due: true, security: v.check?.security ?? 0, note: "" }] });
    }
    return groups.sort((a, b) => envRank(a.env) - envRank(b.env) || a.urgency - b.urgency || (a.cluster ?? a.vms[0]).localeCompare(b.cluster ?? b.vms[0], "fr", { numeric: true }));
}

/** Plan en Markdown (demande de changement, mail, ticket). */
export function planMarkdown(plan, { today = new Date() } = {}) {
    const when = (d) => (d === null ? "à planifier" : d < 0 ? `en retard de ${-d} j` : d === 0 ? "aujourd'hui" : `dans ${d} j`);
    const lines = [`# Ordre de patch proposé (${frDay(new Date(utcDay(today)).toISOString().slice(0, 10))})`, ""];
    plan.forEach((g, i) => {
        lines.push(`## ${i + 1}. ${g.cluster ? `Cluster ${g.cluster}` : g.vms[0]} (${g.env})`, "");
        if (g.warning) lines.push(`> ⚠ ${g.warning}`, "");
        let n = 0;
        for (const s of g.steps) {
            n += 1;
            lines.push(s.kind === "switch"
                ? `${n}. Basculer le PRIMARY de ${s.from} vers ${s.to} (\`dba.getCluster().setPrimaryInstance('${s.to}')\`)`
                : `${n}. Patcher **${s.vm}**${s.role ? ` (${s.role.toUpperCase()}${s.note ? `, ${s.note}` : ""})` : ""} · ${when(s.days)}${s.security ? ` · ${s.security} MAJ de sécurité en attente` : ""}`);
        }
        if (g.cluster) lines.push("", "Entre deux nœuds : `cluster status`, tous les membres ONLINE avant de passer au suivant.");
        lines.push("");
    });
    return lines.join("\n");
}

/** Mots d'environnement retirés des noms pour rapprocher la production de sa recette (app-prod-01 ~ app-rec-01). */
const ENV_WORDS = new Set(["prod", "prd", "production", "rec", "recette", "qualif", "qualification", "qa", "dev", "developpement", "uat", "preprod", "pp", "tst", "test", "int", "hml"]);
/** Clé d'application : nom sans les mots d'environnement (vide si rien ne reste à comparer). */
export const appKey = (name) => {
    const parts = String(name).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[-_.]+/).filter(Boolean);
    const kept = parts.filter((p) => !ENV_WORDS.has(p));
    return kept.length && kept.length < parts.length ? kept.join("-") : "";
};

/**
 * Points de vigilance, regroupés par type (une ligne par type, même avec beaucoup de clusters), du plus grave au moins
 * grave : production prévue avant sa recette, PRIMARY prévu avant ses SECONDARY, PRIMARY non renseigné (warning) ;
 * nœuds d'un cluster prévus le même jour, cluster MySQL sans VIP, redémarrage requis (info).
 * Chaque point : { level, kind, text, unit, items (clusters ou VMs concernés), vms (VMs à ouvrir dans l'inventaire) }.
 * Le retard n'en fait pas partie : il est déjà dans les chiffres, les anneaux et l'ordre de patch.
 */
export function patchRisks(vms, clusters = {}) {
    const groups = new Map();
    const add = (kind, level, text, unit, item, names) => {
        const g = groups.get(kind) ?? { level, kind, text, unit, items: [], vms: new Set() };
        g.items.push(item);
        for (const n of names) g.vms.add(n);
        groups.set(kind, g);
    };
    for (const [cluster, nodes] of clusterNodes(vms)) {
        const names = nodes.map((v) => v.name);
        // Même jour : normal pour une fenêtre de maintenance, à condition de patcher un nœud à la fois
        const days = new Map();
        for (const v of nodes) if (v.nextPatch) days.set(v.nextPatch, (days.get(v.nextPatch) ?? 0) + 1);
        if ([...days.values()].some((n) => n > 1)) add("same-day", "info", "Nœuds d'un même cluster prévus le même jour : un nœud à la fois", "cluster(s)", cluster, names);
        const primary = nodes.find((v) => v.role === "primary");
        const secondaries = nodes.filter((v) => v !== primary && v.nextPatch);
        if (primary?.nextPatch && secondaries.length && primary.nextPatch < secondaries.map((v) => v.nextPatch).sort()[0]) {
            add("primary-first", "warning", "PRIMARY prévu avant ses SECONDARY (à patcher en dernier)", "cluster(s)", `${cluster} (${primary.name})`, names);
        }
        if (!primary && nodes.length > 1) add("no-primary", "warning", "PRIMARY non renseigné", "cluster(s)", cluster, names);
        if (nodes.some((v) => v.profile === "mysql-innodb") && !clusters[cluster]?.vips?.length) add("no-vip", "info", "Cluster MySQL sans VIP renseignée", "cluster(s)", cluster, names);
    }
    // Production prévue avant la recette (ou un autre environnement) de la même application
    const apps = new Map();
    for (const v of live(vms)) {
        const key = appKey(v.cluster || v.name);
        if (key && v.nextPatch) apps.set(key, [...(apps.get(key) ?? []), v]);
    }
    for (const list of apps.values()) {
        const prod = list.filter((v) => v.env === "production").sort((a, b) => a.nextPatch.localeCompare(b.nextPatch));
        const other = list.filter((v) => v.env !== "production").sort((a, b) => a.nextPatch.localeCompare(b.nextPatch));
        if (!prod.length || !other.length || prod[0].nextPatch >= other[0].nextPatch) continue;
        const label = (v) => v.cluster || v.name;
        add("prod-first", "warning", "Production prévue avant sa recette", "application(s)",
            `${label(prod[0])} (${frDay(prod[0].nextPatch)}) → ${label(other[0])} (${frDay(other[0].nextPatch)})`, [...prod, ...other].map((v) => v.name));
    }
    // Redémarrage requis d'après le dernier relevé (noyau ou bibliothèques mis à jour, pas encore pris en compte)
    for (const v of live(vms).filter((x) => x.check?.reboot)) add("reboot", "info", "Redémarrage requis (relevé)", "VM(s)", v.name, [v.name]);
    const rank = { critical: 0, warning: 1, info: 2 };
    return [...groups.values()]
        .map((g) => ({ ...g, items: [...new Set(g.items)].sort((a, b) => a.localeCompare(b, "fr", { numeric: true })), vms: [...g.vms].sort() }))
        .sort((a, b) => rank[a.level] - rank[b.level] || b.items.length - a.items.length);
}
