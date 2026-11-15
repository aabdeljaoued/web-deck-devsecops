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
 * Ordre de patch proposé pour les VMs en retard ou dues dans `horizon` jours :
 * - un groupe par cluster concerné (tous ses nœuds suivis : ils se patchent ensemble), un groupe par VM seule ;
 * - dans un cluster : les SECONDARY d'abord, un nœud à la fois, puis bascule du PRIMARY vers un nœud déjà patché,
 *   et l'ancien PRIMARY en dernier ;
 * - les groupes rangés par environnement (développement, qualification, recette, autre, production), puis par urgence.
 */
export function patchPlan(vms, { today = new Date(), horizon = 7 } = {}) {
    const days = (v) => daysUntil(v.nextPatch, today);
    const due = (v) => days(v) !== null && days(v) <= horizon;
    const groups = [];
    for (const [cluster, nodes] of clusterNodes(vms)) {
        if (!nodes.some(due)) continue;
        const primary = nodes.find((v) => v.role === "primary") ?? null;
        const secondaries = nodes.filter((v) => v !== primary).sort((a, b) => (days(a) ?? 1e6) - (days(b) ?? 1e6) || byName(a, b));
        const step = (v, note = "") => ({ kind: "patch", vm: v.name, role: v.role ?? "", days: days(v), due: due(v), note });
        const steps = secondaries.map((v) => step(v));
        if (primary) {
            if (secondaries.length) steps.push({ kind: "switch", from: primary.name, to: secondaries[0].name });
            steps.push(step(primary, secondaries.length ? "ancien PRIMARY" : ""));
        }
        groups.push({
            env: nodes[0].env, cluster, vms: nodes.map((v) => v.name),
            urgency: Math.min(...nodes.filter(due).map(days)),
            warning: !primary && nodes.length > 1 ? "PRIMARY non renseigné : vérifie-le (cluster status) avant de commencer" : "",
            steps
        });
    }
    for (const v of live(vms).filter((x) => !x.cluster && due(x))) {
        groups.push({ env: v.env, cluster: null, vms: [v.name], urgency: days(v), warning: "", steps: [{ kind: "patch", vm: v.name, role: "", days: days(v), due: true, note: "" }] });
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
                : `${n}. Patcher **${s.vm}**${s.role ? ` (${s.role.toUpperCase()}${s.note ? `, ${s.note}` : ""})` : ""} · ${when(s.days)}`);
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
 * Points de vigilance, du plus grave au moins grave (critical, warning, info), chacun avec les VMs concernées :
 * deux nœuds d'un cluster le même jour, majorité des nœuds en retard, PRIMARY prévu avant ses SECONDARY,
 * PRIMARY non renseigné, production prévue avant sa recette, cluster MySQL sans VIP.
 */
export function patchRisks(vms, clusters = {}, { today = new Date() } = {}) {
    const days = (v) => daysUntil(v.nextPatch, today);
    const risks = [];
    const add = (level, text, names) => risks.push({ level, text, vms: names });
    for (const [cluster, nodes] of clusterNodes(vms)) {
        const prod = nodes.some((v) => v.env === "production");
        // Même jour : un nœud à la fois
        const byDay = new Map();
        for (const v of nodes) if (v.nextPatch) byDay.set(v.nextPatch, [...(byDay.get(v.nextPatch) ?? []), v]);
        for (const [day, same] of byDay) {
            if (same.length > 1) add(prod ? "critical" : "warning", `${cluster} : ${same.length} nœuds prévus le ${frDay(day)} (un nœud à la fois)`, same.map((v) => v.name).sort());
        }
        // Majorité des nœuds en retard
        const late = nodes.filter((v) => (days(v) ?? 1) < 0);
        if (nodes.length > 1 && late.length > nodes.length / 2) {
            add("critical", `${cluster} : ${late.length} nœuds sur ${nodes.length} en retard (un nœud à la fois, quorum vérifié entre chaque)`, late.map((v) => v.name).sort());
        }
        const primary = nodes.find((v) => v.role === "primary");
        const secondaries = nodes.filter((v) => v !== primary && v.nextPatch);
        if (primary?.nextPatch && secondaries.length && primary.nextPatch < secondaries.map((v) => v.nextPatch).sort()[0]) {
            add("warning", `${cluster} : le PRIMARY ${primary.name} est prévu avant ses SECONDARY (à patcher en dernier)`, [primary.name, ...secondaries.map((v) => v.name).sort()]);
        }
        if (!primary && nodes.length > 1) add("warning", `${cluster} : PRIMARY non renseigné`, nodes.map((v) => v.name).sort());
        if (nodes.some((v) => v.profile === "mysql-innodb") && !clusters[cluster]?.vips?.length) {
            add("info", `${cluster} : aucune VIP renseignée`, nodes.map((v) => v.name).sort());
        }
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
        add("warning", `${label(prod[0])} (production, le ${frDay(prod[0].nextPatch)}) est prévu avant ${label(other[0])} (${other[0].env}, le ${frDay(other[0].nextPatch)})`,
            [...new Set([...prod, ...other].map((v) => v.name))].sort());
    }
    const rank = { critical: 0, warning: 1, info: 2 };
    return risks.sort((a, b) => rank[a.level] - rank[b.level] || a.text.localeCompare(b.text, "fr"));
}
