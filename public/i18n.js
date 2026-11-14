// Langue de l'interface (Réglages › Apparence › Langue). Le code et la page sont écrits en français ; en anglais, les
// textes affichés dans les zones traduites (en-tête, Réglages, Patchs…) sont remplacés à l'affichage d'après le
// dictionnaire /i18n/en.js : clé = texte français exact, ou modèle avec variables « {0} » (nombres, noms…).
// Exclus : terminaux, coffre, documentation, et tout élément marqué data-no-i18n (données saisies).
import EN from "/i18n/en.js";
import { compile, translate } from "/i18n-core.js";

export { compile, translate };

// ---------- Page (navigateur) ----------

const COMPILED = compile(EN);
let lang = "fr";
/** Zones traduites (étape 1 : en-tête, barre des touches, Réglages, Patchs, tableau de bord, messages). */
const SCOPE = "header, #grid, #settings, #patches, #patch-dash, #toast, #picker, #keytip, .tabs-bar";
const EXCLUDE = ".xterm, #vault, #docs, [data-no-i18n], [translate=\"no\"], textarea, input, script, style, code, pre";
const ATTRS = ["title", "placeholder", "aria-label"];
const ORIGINAL = new WeakMap();   // nœud texte -> texte français d'origine
const WRITTEN = new WeakMap();    // nœud texte -> dernière valeur écrite par la traduction (pas une modification de la page)

/** Texte français d'origine d'un élément, quelle que soit la langue affichée (pour le code qui s'en sert comme clé). */
export function sourceText(el) {
    if (!el) return "";
    const it = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let out = "";
    for (let n = it.nextNode(); n; n = it.nextNode()) out += ORIGINAL.get(n) ?? n.nodeValue;
    return out;
}

/** Texte affiché dans la langue courante. */
export const t = (text) => (lang === "en" ? translate(COMPILED, text) : String(text));
export const currentLang = () => lang;

const inScope = (el) => el && el.closest?.(SCOPE) && !el.closest(EXCLUDE);
// Champs de saisie : leur valeur n'est jamais traduite, mais leur placeholder et leur infobulle le sont
const attrsInScope = (el) => el && (inScope(el) || (/^(INPUT|TEXTAREA)$/.test(el.tagName) && inScope(el.parentElement)));

function translateText(node) {
    const el = node.parentElement;
    if (!inScope(el)) return;
    if (!ORIGINAL.has(node)) ORIGINAL.set(node, node.nodeValue);
    const next = lang === "en" ? translate(COMPILED, ORIGINAL.get(node)) : ORIGINAL.get(node);
    if (node.nodeValue !== next) { WRITTEN.set(node, next); node.nodeValue = next; }
}

function translateAttrs(el) {
    if (!attrsInScope(el)) return;
    for (const a of ATTRS) {
        if (!el.hasAttribute(a)) continue;
        const key = `i18n${a.replace(/-./g, (x) => x[1].toUpperCase())}`;
        if (el.dataset[key] === undefined) el.dataset[key] = el.getAttribute(a);
        const next = lang === "en" ? translate(COMPILED, el.dataset[key]) : el.dataset[key];
        if (el.getAttribute(a) !== next) { el.dataset[`${key}Out`] = next; el.setAttribute(a, next); }
    }
}

function walk(root) {
    if (root.nodeType === Node.TEXT_NODE) return translateText(root);
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    translateAttrs(root);
    const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = it.nextNode(); n; n = it.nextNode()) {
        if (n.nodeType === Node.TEXT_NODE) translateText(n);
        else translateAttrs(n);
    }
}

// Tout ce qui est ajouté ou modifié par la page est traduit à la volée
const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver((records) => {
    for (const r of records) {
        if (r.type === "childList") r.addedNodes.forEach(walk);
        else if (r.type === "characterData") {
            // Valeur écrite par la traduction elle-même : rien à faire ; sinon, nouveau texte d'origine posé par la page
            if (WRITTEN.get(r.target) === r.target.nodeValue) continue;
            ORIGINAL.set(r.target, r.target.nodeValue);
            translateText(r.target);
        } else if (r.type === "attributes" && ATTRS.includes(r.attributeName)) {
            const key = `i18n${r.attributeName.replace(/-./g, (x) => x[1].toUpperCase())}`;
            const value = r.target.getAttribute(r.attributeName);
            if (value === null || value === r.target.dataset[`${key}Out`]) continue;
            r.target.dataset[key] = value;
            translateAttrs(r.target);
        }
    }
});

/** Change la langue de l'interface (fr ou en) ; la page entière est retraduite sans rechargement. */
export function setLang(next) {
    lang = next === "en" ? "en" : "fr";
    if (typeof document === "undefined") return;
    document.documentElement.lang = lang;
    if (observer && !setLang.started) {
        observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
        setLang.started = true;
    }
    walk(document.body);
}
