// Rapport d'intervention (Réglages › Journal) : compte rendu Markdown d'une période, assemblé à partir du
// journal des actions, des sessions enregistrées (● REC) et des étapes de runbook cochées dans le coffre.
// Rien n'est envoyé ailleurs : le texte est renvoyé à la page, qui le montre pour relecture avant export.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const MAX_SESSION_LINES = 200;   // lignes gardées par session (les dernières)

const fmt = (d) => new Date(d).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const hour = (d) => new Date(d).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
/** Cellule de tableau Markdown : barres verticales et retours à la ligne neutralisés. */
const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ").trim();

/**
 * @param from, to       période (Date ou ISO)
 * @param entries        entrées du journal (les plus anciennes d'abord ou non : triées ici)
 * @param recordings     [{ name, time }] (.cast) et dir, le dossier des enregistrements
 * @param notes          notes du coffre (null si verrouillé) : seules celles qui ont des étapes cochées
 * @param withSessions   inclure le texte des sessions (.txt)
 */
export function buildReport({ from, to = new Date(), entries = [], recordings = [], dir = "", notes = null, mission = null, withSessions = false }) {
    const start = new Date(from).getTime();
    const end = new Date(to).getTime();
    const inRange = (t) => { const x = new Date(t).getTime(); return x >= start && x <= end; };
    const actions = entries.filter((e) => inRange(e.time)).sort((a, b) => a.time.localeCompare(b.time));
    const sessions = recordings.filter((r) => inRange(r.time)).sort((a, b) => a.time.localeCompare(b.time));
    const runbooks = (notes ?? []).filter((n) => n.done?.length);
    const prod = actions.filter((e) => e.prod).length;

    const out = [
        `# Rapport d'intervention${mission ? ` : ${mission}` : ""}`,
        "",
        `- **Période** : du ${fmt(start)} au ${fmt(end)}`,
        `- **Actions lancées depuis le deck** : ${actions.length}${prod ? ` (dont **${prod} en production**)` : ""}`,
        `- **Sessions enregistrées** : ${sessions.length}`,
        ""
    ];

    out.push("## Actions", "");
    if (!actions.length) out.push("_Aucune action notée sur cette période (journal désactivé ou vide)._", "");
    else {
        out.push("| Heure | Action | Commande | Contexte kubectl | Mode |", "|---|---|---|---|---|");
        for (const e of actions) {
            out.push(`| ${hour(e.time)} | ${cell(e.label)} | \`${cell(e.command)}\` | ${e.prod ? "⚠ **PROD** " : ""}${cell(e.kube ?? "")} | ${cell(e.mode)} |`);
        }
        out.push("");
    }

    out.push("## Sessions enregistrées", "");
    if (!sessions.length) out.push("_Aucune session enregistrée (● REC) sur cette période._", "");
    for (const r of sessions) {
        const base = r.name.replace(/\.cast$/, "");
        out.push(`### ${base}`, "", `Fichiers : \`${base}.cast\` (rejouable) et \`${base}.txt\`.`, "");
        if (withSessions) {
            const txt = path.join(dir, `${base}.txt`);
            if (existsSync(txt)) {
                const lines = readFileSync(txt, "utf8").replace(/\s+$/, "").split("\n");
                const kept = lines.slice(-MAX_SESSION_LINES);
                if (lines.length > kept.length) out.push(`_${lines.length - kept.length} premières lignes omises._`, "");
                out.push("~~~text", ...kept.map((l) => l.replace(/^~~~/, "\\~~~")), "~~~", "");
            }
        }
    }

    out.push("## Runbooks suivis", "");
    if (notes === null) out.push("_Coffre verrouillé : les étapes cochées des runbooks ne sont pas incluses._", "");
    else if (!runbooks.length) out.push("_Aucune étape de runbook cochée._", "");
    for (const n of runbooks) {
        out.push(`### ${n.title || "Sans titre"}`, "", ...n.done.map((l) => `- [x] \`${l.replace(/`/g, "'")}\``), "");
    }

    out.push("---", `_Rapport généré par Web Deck DevSecOps le ${fmt(new Date())}. À relire avant diffusion : les commandes et sorties peuvent contenir des informations internes._`, "");
    return out.join("\n");
}
