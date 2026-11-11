// Suivi du parc de la mission : échéances (calendrier et export .ics), état du parc (certificats et VMs par
// environnement) et synthèse du client en Markdown. Calculé à partir de l'inventaire des patchs, des
// certificats vérifiés par le voyant et du journal ; rien n'est envoyé ailleurs.
import { createHash } from "node:crypto";

import { daysUntil } from "./patches.mjs";

const fr = (iso) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "—");
const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ").trim();
const isProd = (env) => (env ?? "production") === "production";

/** Niveau d'une VM (comme le voyant patchs) : rouge à J-1 ou en retard, orange à 7 j ou moins / à planifier. */
export function vmLevel(vm, now = new Date()) {
    if (!vm.nextPatch) return "orange";
    const d = daysUntil(vm.nextPatch, now);
    return d <= 1 ? "rouge" : d <= 7 ? "orange" : "ok";
}

/**
 * Échéances : prochains patchs des VMs et expirations des certificats (vérifiés par le voyant), triées par date.
 * @returns [{ date: "AAAA-MM-JJ", kind: "patch" | "certificat", title, env, level, detail }]
 */
export function agendaEvents({ vms = [], certs = [], now = new Date() }) {
    const events = [];
    for (const vm of vms) {
        if (!vm.nextPatch) continue;
        events.push({ date: vm.nextPatch, kind: "patch", title: `Patch ${vm.name}`, env: vm.env, level: vmLevel(vm, now),
            detail: [vm.description, vm.host && vm.host !== vm.name ? `hôte ${vm.host}` : "", vm.everyDays ? `tous les ${vm.everyDays} j` : ""].filter(Boolean).join(" · ") });
    }
    for (const c of certs) {
        if (!c.until || c.error || c.intercepted) continue;
        events.push({ date: c.until.slice(0, 10), kind: "certificat", title: `Expiration du certificat ${c.target}`, env: c.env ?? "production",
            level: c.level ?? "ok", detail: c.issuer ? `émis par ${c.issuer}` : "" });
    }
    return events.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}

/** Texte iCalendar échappé (virgule, point-virgule, antislash, retour à la ligne). */
const icsText = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/([,;])/g, "\\$1").replace(/\r?\n/g, "\\n");
/** Lignes de 75 octets au plus (RFC 5545), suite précédée d'une espace. */
function fold(line) {
    const out = [];
    let rest = line;
    while (Buffer.byteLength(rest) > 75) {
        let n = 75;
        while (Buffer.byteLength(rest.slice(0, n)) > 75) n--;
        out.push(rest.slice(0, n));
        rest = ` ${rest.slice(n)}`;
    }
    out.push(rest);
    return out.join("\r\n");
}

/**
 * Calendrier .ics (Outlook, Google Agenda) : un événement « journée entière » par échéance, rappel 3 jours avant
 * en production, 1 jour avant sinon. UID stable : réimporter met à jour au lieu de dupliquer.
 */
export function toIcs(events, { name = "Deck DevSecOps", now = new Date() } = {}) {
    const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const day = (d) => d.replace(/-/g, "");
    const next = (d) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10).replace(/-/g, ""); };
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Web Deck DevSecOps//Echeances//FR", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", `X-WR-CALNAME:${icsText(name)}`];
    for (const e of events) {
        const uid = createHash("sha256").update(`${e.kind}|${e.title}`).digest("hex").slice(0, 24);
        lines.push("BEGIN:VEVENT", `UID:${uid}@web-deck-devsecops`, `DTSTAMP:${stamp}`,
            `DTSTART;VALUE=DATE:${day(e.date)}`, `DTEND;VALUE=DATE:${next(e.date)}`,
            `SUMMARY:${icsText(`${isProd(e.env) ? "[PROD] " : `[${e.env}] `}${e.title}`)}`,
            `DESCRIPTION:${icsText(e.detail || e.title)}`, `CATEGORIES:${icsText(e.kind === "patch" ? "Patch" : "Certificat")}`,
            "BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsText(e.title)}`, `TRIGGER:-P${isProd(e.env) ? 3 : 1}D`, "END:VALARM", "END:VEVENT");
    }
    lines.push("END:VCALENDAR");
    return `${lines.map(fold).join("\r\n")}\r\n`;
}

/** État du parc à date : certificats et VMs par environnement, éléments à traiter (Markdown). */
export function parcMarkdown({ vms = [], certs = [], now = new Date() }) {
    const out = [];
    const envs = (items, envOf) => [...new Set(items.map(envOf))].sort((a, b) => (isProd(a) ? -1 : isProd(b) ? 1 : a.localeCompare(b)));
    const count = (items, pred) => items.filter(pred).length;

    out.push("### Certificats", "");
    if (!certs.length) out.push("_Aucun certificat suivi (Réglages › Missions › Certificats)._", "");
    else {
        out.push("| Environnement | Suivis | 🔴 urgents | 🟠 à renouveler | Injoignables |", "|---|---|---|---|---|");
        for (const env of envs(certs, (c) => c.env ?? "production")) {
            const list = certs.filter((c) => (c.env ?? "production") === env);
            out.push(`| ${isProd(env) ? "**production**" : env} | ${list.length} | ${count(list, (c) => c.level === "rouge")} | ${count(list, (c) => c.level === "orange")} | ${count(list, (c) => c.error)} |`);
        }
        const todo = certs.filter((c) => c.level === "rouge" || c.level === "orange" || c.error).sort((a, b) => (a.days ?? 1e9) - (b.days ?? 1e9));
        out.push("");
        for (const c of todo) out.push(`- ${c.level === "rouge" ? "🔴" : c.error ? "⚪" : "🟠"} \`${c.target}\` (${c.env ?? "production"}) : ${c.error ? `injoignable, ${c.error}` : c.days < 0 ? `**expiré** depuis ${-c.days} j` : `expire dans ${c.days} j (${fr(c.until)})`}`);
        if (todo.length) out.push("");
    }

    out.push("### Patchs des VMs", "");
    if (!vms.length) out.push("_Aucune VM dans l'inventaire (rubrique Patchs)._", "");
    else {
        out.push("| Environnement | VMs | 🔴 en retard ou J-1 | 🟠 sous 7 j | Reboot requis |", "|---|---|---|---|---|");
        for (const env of envs(vms, (v) => v.env)) {
            const list = vms.filter((v) => v.env === env);
            out.push(`| ${isProd(env) ? "**production**" : env} | ${list.length} | ${count(list, (v) => vmLevel(v, now) === "rouge")} | ${count(list, (v) => vmLevel(v, now) === "orange")} | ${count(list, (v) => v.check?.reboot)} |`);
        }
        const todo = vms.filter((v) => vmLevel(v, now) !== "ok" || v.check?.reboot || v.check?.security).sort((a, b) => (a.nextPatch || "").localeCompare(b.nextPatch || ""));
        out.push("");
        for (const v of todo) {
            const d = v.nextPatch ? daysUntil(v.nextPatch, now) : null;
            const when = d === null ? "patch à planifier" : d < 0 ? `**patch en retard de ${-d} j**` : d === 0 ? "patch aujourd'hui" : `patch dans ${d} j (${fr(v.nextPatch)})`;
            const check = v.check && !v.check.error ? ` · ${v.check.updates} MAJ en attente${v.check.security ? ` dont ${v.check.security} de sécurité` : ""}${v.check.reboot ? " · reboot requis" : ""} (vérifié le ${fr(v.check.at)})` : "";
            out.push(`- ${vmLevel(v, now) === "rouge" ? "🔴" : vmLevel(v, now) === "orange" ? "🟠" : "🟢"} \`${v.name}\` (${v.env}) : ${when}${check}`);
        }
        if (todo.length) out.push("");
    }
    return out.join("\n");
}

/** Synthèse du client (mission active) : contexte, état du parc, échéances à 30 jours, actions récentes en production. */
export function buildSummary({ mission = null, kube = null, vms = [], certs = [], entries = [], now = new Date() }) {
    const since = new Date(now.getTime() - 7 * 86400000);
    const prodActions = entries.filter((e) => e.prod && new Date(e.time) >= since).sort((a, b) => b.time.localeCompare(a.time));
    const soon = agendaEvents({ vms, certs, now }).filter((e) => daysUntil(e.date, now) <= 30);
    const out = [
        `# Synthèse${mission ? ` : ${mission}` : ""}`,
        "",
        `_État au ${now.toLocaleDateString("fr-FR")} à ${now.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}._`,
        "",
        `- **Contexte kubectl** : ${kube?.context ? `${kube.context} / ${kube.namespace}${kube.prod ? " (**PRODUCTION**)" : ""}` : "aucun"}`,
        `- **Certificats suivis** : ${certs.length} · **VMs** : ${vms.length}`,
        `- **Actions en production (7 derniers jours)** : ${prodActions.length}`,
        "",
        "## État du parc",
        "",
        parcMarkdown({ vms, certs, now }),
        "## Échéances : en retard et 30 prochains jours",
        ""
    ];
    if (!soon.length) out.push("_Aucune échéance en retard ni dans les 30 prochains jours._", "");
    else {
        out.push("| Date | Échéance | Environnement |", "|---|---|---|");
        for (const e of soon) out.push(`| ${fr(e.date)} | ${cell(e.title)} | ${isProd(e.env) ? "**production**" : e.env} |`);
        out.push("");
    }
    out.push("## Dernières actions en production", "");
    if (!prodActions.length) out.push("_Aucune action en production ces 7 derniers jours (journal)._", "");
    else {
        out.push("| Date | Action | Commande | Contexte |", "|---|---|---|---|");
        for (const e of prodActions.slice(0, 15)) out.push(`| ${new Date(e.time).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })} | ${cell(e.label)} | \`${cell(e.command)}\` | ${cell(e.kube)} |`);
        out.push("");
    }
    out.push("---", "_Synthèse générée par Web Deck DevSecOps. À relire avant diffusion._", "");
    return out.join("\n");
}
