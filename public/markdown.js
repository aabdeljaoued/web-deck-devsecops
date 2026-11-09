// Markdown des notes du coffre : rendu ANSI (affichage dans le terminal, pour sélectionner puis lancer une action)
// et rendu HTML (aperçu dans le coffre). Sous-ensemble courant : titres, listes (et cases à cocher), citations,
// blocs de code, tableaux, séparateurs, gras, italique, barré, code, liens.
// Sûreté : les caractères de contrôle sont retirés (une note ne peut pas piloter le terminal) ; en HTML tout le
// texte est échappé et seuls les liens http(s) sont gardés.

/** Retire les caractères de contrôle (séquences d'échappement comprises), tabulations -> 4 espaces. */
export const sanitize = (s) => String(s ?? "").replace(/\t/g, "    ").replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "");

/** Découpe en blocs : { type, ... } (titre, code, liste, citation, tableau, séparateur, paragraphe, vide). */
export function parse(markdown) {
    const lines = sanitize(markdown).replace(/\r\n?/g, "\n").split("\n");
    const blocks = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const fence = /^\s*(`{3,}|~{3,})\s*([\w+-]*)/.exec(line);
        if (fence) {
            const code = [];
            for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) code.push(lines[i]);
            blocks.push({ type: "code", lang: fence[2], lines: code });
            continue;
        }
        let m;
        if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) { blocks.push({ type: "heading", level: m[1].length, text: m[2] }); continue; }
        if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { blocks.push({ type: "hr" }); continue; }
        if ((m = /^\s*>\s?(.*)$/.exec(line))) { blocks.push({ type: "quote", text: m[1] }); continue; }
        if ((m = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/.exec(line))) {
            blocks.push({ type: "item", depth: Math.floor(m[1].length / 2), marker: m[2], task: m[3] ? /x/i.test(m[3]) : null, text: m[4] });
            continue;
        }
        if (/^\s*\|.*\|\s*$/.test(line)) {
            const rows = [];
            for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) {
                const cells = lines[i].trim().slice(1, -1).split("|").map((c) => c.trim());
                if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);   // ligne de séparation ignorée
            }
            i--;
            blocks.push({ type: "table", rows });
            continue;
        }
        blocks.push(line.trim() ? { type: "para", text: line } : { type: "blank" });
    }
    return blocks;
}

// ---------- Terminal (ANSI) ----------

const SGR = (...codes) => `\x1b[${codes.join(";")}m`;
const RESET = SGR(0);

/**
 * Code en ligne mis à l'abri pendant la mise en forme (un « * » dans `rm -rf *` n'est pas de l'italique) :
 * remplacé par un repère \u0000n\u0000 (les caractères de contrôle ont été retirés du texte), puis remis.
 */
function protectCode(text, render, format) {
    const codes = [];
    const body = format(text.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`));
    return body.replace(/\u0000(\d+)\u0000/g, (_, n) => render(codes[Number(n)]));
}

function inlineAnsi(text) {
    return protectCode(text, (c) => `${SGR(33)}${c}${RESET}`, (t) => t
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `${SGR(4, 34)}${t}${RESET} ${SGR(2)}${u}${RESET}`)
        .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => `${SGR(1)}${a ?? b}${SGR(22)}`)
        .replace(/~~([^~]+)~~/g, (_, t) => `${SGR(9)}${t}${SGR(29)}`)
        .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, (_, p, t) => `${p}${SGR(3)}${t}${SGR(23)}`)
        .replace(/(^|[\s(])_([^_\s][^_]*)_/g, (_, p, t) => `${p}${SGR(3)}${t}${SGR(23)}`));
}

/**
 * Note mise en forme pour le terminal (lignes séparées par \r\n), encadrée par un titre et une ligne de fin.
 * Les lignes de code n'ont aucun décor (couleur et retrait seulement) : une commande sélectionnée reste propre.
 */
export function toAnsi(markdown, title = "", cols = 80) {
    const width = Math.max(20, Math.min(cols, 100));
    const rule = (label = "") => `${SGR(2)}${label ? `── ${label} ` : ""}${"─".repeat(Math.max(4, width - (label ? label.length + 4 : 0)))}${RESET}`;
    const out = ["", rule(title ? `Note : ${sanitize(title)}` : "Note")];
    for (const b of parse(markdown)) {
        if (b.type === "heading") out.push(b.level === 1 ? `${SGR(1, 4, 96)}${b.text}${RESET}` : b.level === 2 ? `${SGR(1, 36)}${b.text}${RESET}` : `${SGR(1)}${b.text}${RESET}`);
        else if (b.type === "code") {
            if (b.lang) out.push(`${SGR(2)}  ${b.lang}${RESET}`);
            for (const l of b.lines) out.push(`  ${SGR(32)}${l}${RESET}`);
        } else if (b.type === "item") {
            const bullet = b.task === true ? `${SGR(32)}☑${RESET}` : b.task === false ? "☐" : /\d/.test(b.marker) ? b.marker : "•";
            out.push(`${"  ".repeat(b.depth + 1)}${bullet} ${inlineAnsi(b.text)}`);
        } else if (b.type === "quote") out.push(`  ${SGR(2)}▌${RESET} ${SGR(3)}${inlineAnsi(b.text)}${SGR(23)}`);
        else if (b.type === "hr") out.push(rule());
        else if (b.type === "table") {
            const widths = b.rows[0]?.map((_, c) => Math.max(...b.rows.map((r) => (r[c] ?? "").length))) ?? [];
            b.rows.forEach((r, i) => {
                const line = r.map((cell, c) => cell.padEnd(widths[c])).join("  ");
                out.push(i === 0 ? `  ${SGR(1)}${line}${RESET}` : `  ${line}`);
            });
        } else if (b.type === "para") out.push(inlineAnsi(b.text));
        else out.push("");
    }
    out.push(rule("fin de la note"), "");
    return out.join("\r\n");
}

// ---------- Aperçu (HTML) ----------

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inlineHtml(text) {
    return protectCode(esc(text), (c) => `<code>${c}</code>`, (t) => t
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)"]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
        .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => `<strong>${a ?? b}</strong>`)
        .replace(/~~([^~]+)~~/g, "<del>$1</del>")
        .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
        .replace(/(^|[\s(])_([^_\s][^_]*)_/g, "$1<em>$2</em>"));
}

export function toHtml(markdown) {
    const html = [];
    for (const b of parse(markdown)) {
        if (b.type === "heading") html.push(`<h${b.level}>${inlineHtml(b.text)}</h${b.level}>`);
        // Une ligne de code par <span> : cliquable dans l'aperçu (tapée dans le terminal) ; le texte copié reste le même
        else if (b.type === "code") html.push(`<pre${b.lang ? ` data-lang="${esc(b.lang)}"` : ""}><code>${b.lines.map((l) => `<span class="md-code-line">${esc(l)}</span>`).join("\n")}</code></pre>`);
        else if (b.type === "item") {
            const box = b.task === null ? "" : `<input type="checkbox" disabled${b.task ? " checked" : ""}> `;
            html.push(`<p class="md-item" style="--depth:${b.depth}"><span class="md-bullet">${/\d/.test(b.marker) ? esc(b.marker) : "•"}</span> ${box}${inlineHtml(b.text)}</p>`);
        } else if (b.type === "quote") html.push(`<blockquote>${inlineHtml(b.text)}</blockquote>`);
        else if (b.type === "hr") html.push("<hr>");
        else if (b.type === "table") {
            const [head, ...rows] = b.rows;
            html.push(`<table><thead><tr>${(head ?? []).map((c) => `<th>${inlineHtml(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inlineHtml(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
        } else if (b.type === "para") html.push(`<p>${inlineHtml(b.text)}</p>`);
    }
    return html.join("\n");
}
