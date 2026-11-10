// Page du deck : grille de touches (rubriques, voyants) et terminaux xterm.js reliés au serveur.
import { Terminal } from "/vendor/xterm.mjs";
import { FitAddon } from "/vendor/addon-fit.mjs";
import { WebLinksAddon } from "/vendor/addon-web-links.mjs";
import { SearchAddon } from "/vendor/addon-search.mjs";
import { toAnsi, toHtml } from "/markdown.js";

const $ = (sel) => document.querySelector(sel);

/** Version de la page chargée (empreinte envoyée par le serveur dans « hello »). */
let pageBuild = null;

const state = {
    ws: null,
    tools: { missing: new Set(), install: {} },   // outils installables absents (server/tools.mjs)
    localUnix: true,                              // poste Linux / macOS (sinon : rubriques "unix" via ssh / wsl)
    remote: {},                                   // sid -> "ssh" | "wsl" : terminaux connectés (server/remote.mjs)
    server: null,                                 // mode de lancement (service ou à la main)
    pages: {},
    titles: {},
    page: "root",
    status: {},
    shells: [],         // [{ name, kind }] ; kind : posix, powershell ou cmd
    windowsPty: null,   // serveur Windows : infos ConPTY pour xterm.js
    terms: new Map(),   // sid -> { term, fit, tab, screen, ended, kind }
    layout: loadLayout(),   // disposition des terminaux : "tabs" (1, onglets), "2x1" ou "2x2"
    active: null,
    pending: [],        // textes à envoyer au prochain terminal ouvert par cette page
    broadcast: false,   // diffusion : saisie et touches envoyées à tous les terminaux visibles
    notify: loadPref("deck-notify") === "1",              // notification quand une commande longue se termine
    fontSize: Number(loadPref("deck-font")) || 14,        // taille du texte des terminaux
    favEdit: false,     // rubrique Favoris en mode Modifier : un clic sur un favori ouvre son formulaire
    parents: {},        // page -> page parente (fil d'Ariane, Retour)
    vault: { exists: null, unlocked: false },   // coffre : notes et secrets (sans leur valeur) ; exists null = pas encore connu
    settings: { autoHomeEnabled: true, autoHomeSeconds: 60 },   // réglages de l'espace admin (serveur)
    favGroups: []       // groupes de favoris { id, path, depth } pour le choix « Dans »
};
const requestId = crypto.randomUUID();
/** Dispositions : nombre de terminaux visibles, colonnes et lignes. */
const LAYOUTS = { "tabs": { size: 1, cols: 1, rows: 1 }, "2x1": { size: 2, cols: 2, rows: 1 }, "2x2": { size: 4, cols: 2, rows: 2 } };
const layout = () => LAYOUTS[state.layout];

/** Disposition mémorisée entre deux chargements (si le navigateur autorise le stockage local). */
function loadLayout() {
    try {
        const saved = localStorage.getItem("deck-layout") ?? (localStorage.getItem("deck-grid") === "1" ? "2x2" : "tabs");
        return saved in LAYOUTS ? saved : "tabs";
    } catch { return "tabs"; }
}
function saveLayout() {
    savePref("deck-layout", state.layout);
}
function loadPref(name) {
    try { return localStorage.getItem(name); } catch { return null; }
}
function savePref(name, value) {
    try { localStorage.setItem(name, value); } catch { /* stockage refusé */ }
}
// ---------- Apparence : mode sombre / clair / système et thème de mission (Réglages, côté serveur) ----------
// Les couleurs sont dans style.css ([data-mode], [data-theme]). La dernière apparence est gardée dans le
// navigateur pour l'appliquer dès le chargement (pas de flash), puis le serveur fait foi.

const THEMES = ["allianz", "bnp", "estreem", "laposte"];
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

/** Couleurs du terminal : sombre (défaut xterm) ou clair (palette lisible sur fond blanc). */
// Fond transparent : celui de l'écran (et la signature en filigrane) se voit derrière le texte
const TERM_THEMES = {
    dark: { background: "rgba(0, 0, 0, 0)" },
    light: {
        background: "rgba(0, 0, 0, 0)", foreground: "#1c2330", cursor: "#1c2330", cursorAccent: "#ffffff", selectionBackground: "#b3d4fc",
        black: "#1c2330", red: "#c62828", green: "#2e7d32", yellow: "#8a6d00", blue: "#1565c0", magenta: "#8e24aa", cyan: "#00838f", white: "#5f6b7a",
        brightBlack: "#5f6b7a", brightRed: "#e53935", brightGreen: "#43a047", brightYellow: "#a07c00", brightBlue: "#1e88e5", brightMagenta: "#ab47bc", brightCyan: "#0097a7", brightWhite: "#1c2330"
    }
};
let currentMode = "dark";

/** Applique un mode ("dark", "light", "system") et un thème de mission ("" = aucun). */
/**
 * Signature en filigrane au fond de chaque terminal (Réglages › Apparence) :
 * l'image signature.png si elle existe (peinte en gris par masque), sinon le texte.
 */
function applyWatermark(text = state.settings?.watermark ?? "", style = state.settings?.watermarkStyle ?? "text", font = state.settings?.watermarkFont ?? "ANSI Shadow") {
    const root = document.documentElement;
    const image = state.signature;
    // Bannière ASCII : dessinée par le serveur (FIGlet), mise en cache ; affichée à sa réception
    const ascii = !image && style === "ascii" && text;
    root.classList.remove("watermark-ascii");
    if (ascii) {
        const key = `${text}|${font}`;
        bannerWanted = key;
        if (bannerCache.has(key)) setBanner(bannerCache.get(key));
        else send({ t: "banner", text, font });
    } else {
        bannerWanted = null;
        root.style.setProperty("--watermark", JSON.stringify(text));
    }
    if (image) root.style.setProperty("--wm-image", `url("/signature.png?v=${image}")`);
    root.classList.toggle("watermark", Boolean(text) || Boolean(image));
    root.classList.toggle("watermark-image", Boolean(image));
    const info = document.querySelector("#set-signature-state");
    if (info) info.textContent = image ? "image utilisée (elle remplace le texte)" : "aucune image : le texte ci-dessus est utilisé";
    const remove = document.querySelector("#set-signature-remove");
    if (remove) remove.disabled = !image;
}

const bannerCache = new Map();   // "texte|police" -> bannière ASCII
let bannerWanted = null;

/** Chaîne CSS (content:) : retours à la ligne en \00000A (forme longue : l'espace suivante n'est pas avalée), avec white-space: pre. */
const cssString = (s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\00000A")}"`;

function setBanner(art) {
    const root = document.documentElement;
    const lines = art.split("\n");
    root.style.setProperty("--watermark", cssString(art));
    root.style.setProperty("--wm-cols", Math.max(1, ...lines.map((l) => [...l].length)));
    root.style.setProperty("--wm-rows", lines.length);
    root.classList.add("watermark-ascii");
}

/** Image de signature choisie dans les Réglages : envoyée au serveur (PNG, 600 Ko au plus). */
async function uploadSignature(file) {
    if (!file) return;
    try {
        if (file.size > 600 * 1024) throw new Error("image trop lourde (600 Ko au plus)");
        const data = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
            reader.onerror = () => reject(new Error("lecture impossible"));
            reader.readAsDataURL(file);
        });
        send({ t: "signature-upload", data });
    } catch (err) {
        toast(err.message);
    } finally {
        $("#set-signature-file").value = "";
    }
}

function applyAppearance(appearance = "dark", theme = "") {
    currentMode = appearance === "system" ? (systemDark.matches ? "dark" : "light") : appearance === "light" ? "light" : "dark";
    const root = document.documentElement;
    root.dataset.mode = currentMode;
    if (THEMES.includes(theme)) root.dataset.theme = theme;
    else delete root.dataset.theme;
    savePref("deck-appearance", JSON.stringify({ appearance, theme }));
    // Un terminal en cours de fermeture ne doit pas bloquer la suite (fermeture des Réglages, etc.)
    for (const t of state.terms?.values() ?? []) {
        try { t.term.options.theme = TERM_THEMES[currentMode]; } catch (err) { console.warn("thème du terminal", err); }
    }
}
const termTheme = () => TERM_THEMES[currentMode];
systemDark.addEventListener("change", () => {
    if (state.settings?.appearance === "system") applyAppearance("system", state.settings.missionTheme);
});
try {
    const cached = JSON.parse(loadPref("deck-appearance") ?? "null");
    applyAppearance(cached?.appearance, cached?.theme);
} catch { applyAppearance(); }

// Navigateur sous macOS : Cmd+C / Cmd+V copient et collent déjà ; ailleurs, Ctrl+C / Ctrl+V sont gérés plus bas
// (insensible à la casse : Chrome renvoie "macOS", Safari "MacIntel")
const macClient = /mac|iphone|ipad/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent);

// ---------- Connexion ----------

function connect() {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    state.ws = ws;
    ws.onopen = () => setConn("connecté", "ok");
    ws.onclose = () => {
        setConn("déconnecté, nouvelle tentative…", "ko");
        setTimeout(connect, 2000);
    };
    ws.onmessage = (ev) => handle(JSON.parse(ev.data));
}

function send(msg) {
    if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(msg));
}

/** Pastille de connexion au serveur (verte / rouge) ; l'état en clair dans l'infobulle. */
function setConn(text, cls) {
    const el = $("#conn");
    const label = `Serveur du deck : ${text}`;
    el.title = label;
    el.setAttribute("aria-label", label);
    el.className = `conn ${cls}`;
}

function handle(msg) {
    switch (msg.t) {
        case "hello": {
            // Serveur redémarré avec une autre version de la page : rechargement (sinon l'ancien code reste actif)
            if (pageBuild && msg.build && msg.build !== pageBuild) {
                toast("nouvelle version du deck : rechargement…", "ok");
                setTimeout(() => location.reload(), 600);
                return;
            }
            pageBuild = msg.build ?? null;
            state.rec = new Set(msg.rec ?? []);
            state.pages = msg.pages;
            state.titles = msg.titles;
            state.parents = msg.parents ?? {};
            state.favGroups = msg.favGroups ?? [];
            state.worlds = msg.worlds ?? null;
            state.server = msg.server ?? null;
            state.localUnix = msg.localUnix ?? true;
            if (msg.update) applyUpdate(msg.update);
            state.workspace = msg.workspace ?? "";
            state.actions = msg.actions ?? [];
            state.prodPatternDefault = msg.prodPattern ?? "prod";
            state.signature = msg.signature ?? null;
            applyWatermark();
            state.remote = msg.remote ?? {};
            if (msg.tools) applyTools(msg.tools);
            state.status = msg.status ?? {};
            if (msg.vault) applyVault(msg.vault);
            if (msg.settings) {
                state.settings = msg.settings;
                setTimeout(renderMissionSwitch);
                applyWatermark();
                applyAppearance(msg.settings.appearance, msg.settings.missionTheme);
            }
            state.windowsPty = msg.windowsPty ?? null;
            if (!state.pages[state.page]) state.page = "root";
            fillShells(msg.shells);
            // Reconnexion ou rechargement : on repart des sessions du serveur, sortie rejouée
            for (const sid of [...state.terms.keys()]) removeTerm(sid);
            for (const s of msg.sessions) addTerm(s.sid, s.name, s.kind, s.replay, s.title);
            markRemoteTabs();
            if (msg.sessions.length) activate(msg.sessions.at(-1).sid);
            layoutScreens();
            if (layout().size > 1) fillGrid();
            else if (!msg.sessions.length) openTerm();
            render();
            break;
        }
        case "opened":
            if (!state.terms.has(msg.sid)) {
                addTerm(msg.sid, msg.name, msg.kind, "", msg.title);
                layoutScreens();
                markRemoteTabs();
            }
            if (msg.by === requestId) {
                activate(msg.sid);
                for (const text of state.pending.splice(0)) send({ t: "in", sid: msg.sid, d: text });
            }
            break;
        case "out": {
            const t = state.terms.get(msg.sid);
            if (!t) break;
            t.term.write(msg.d);
            trackActivity(msg.sid, t);
            break;
        }
        case "deck":
            // Favoris modifiés (ici ou dans une autre page) : touches mises à jour
            state.pages = msg.pages;
            state.titles = msg.titles;
            const oldParents = state.parents;
            state.parents = msg.parents ?? {};
            state.favGroups = msg.favGroups ?? [];
            if (msg.worlds) state.worlds = msg.worlds;
            // Rubrique désactivée pendant qu'on était dedans : retour à l'accueil (comme un groupe supprimé)
            if (autoHome.world && !state.pages[autoHome.world]) cancelAutoHome();
            // Groupe supprimé pendant qu'on était dedans : on remonte au premier niveau qui existe encore
            while (!state.pages[state.page]) state.page = oldParents[state.page] ?? "root";
            render();
            break;
        case "fav-saved":
            if (favMoving) favMoving = false;   // déplacement : le formulaire reste ouvert
            else closeFavForm();
            break;
        case "settings":
            state.settings = msg.settings;
            renderMissionSwitch();
            if (!$("#settings").hidden) renderMissions();
            applyWatermark();
            if (msg.settings.autoHomeEnabled === false) cancelAutoHome();
            settingsPending = false;
            applyAppearance(msg.settings.appearance, msg.settings.missionTheme);
            break;
        case "vault":
            applyVault(msg);
            if (!msg.unlocked && msg.reason === "inactivité") toast("coffre verrouillé après 15 min d'inactivité", "ok");
            if (!msg.unlocked && msg.reason === "écran verrouillé") toast("coffre verrouillé avec la session", "ok");
            break;
        case "note-saved":
            if (msg.req === noteReq && !vaultUi.noteId) {
                vaultUi.noteId = msg.id;
                scheduleNote();   // ce qui a été tapé avant la création est enregistré aussi
            } else {
                $("#note-status").textContent = "enregistrée";
            }
            renderNotes();
            break;
        case "secret-value":
            useSecretValue(msg);
            break;
        case "actions":
            state.actions = msg.sections ?? [];
            if (!$("#settings").hidden) renderActions();
            break;
        case "action-saved":
            actionDone();
            if (actImport) { actImport = null; $("#act-import-confirm").hidden = true; }
            $("#act-section-form").hidden = true;
            $("#act-form").hidden = true;
            if (msg.created && !msg.shown) toast("rubrique créée, mais l'accueil est plein (18 touches) : décoche une rubrique dans « Rubriques » pour l'afficher");
            else toast(msg.created ? "rubrique créée et affichée sur l'accueil" : "enregistré", "ok");
            if (!$("#settings").hidden) renderWorldChoices();
            break;
        case "mission-saved":
            missionDone();
            $("#mission-form").hidden = true;
            toast(`mission « ${msg.name} » enregistrée`, "ok");
            break;
        case "tools":
            applyTools(msg);
            break;
        case "banner":
            bannerCache.set(msg.key, msg.art);
            if (msg.key === bannerWanted) setBanner(msg.art);
            break;
        case "signature":
            state.signature = msg.version ?? null;
            applyWatermark();
            break;
        case "remote":
            state.remote = msg.remote ?? {};
            markRemoteTabs();
            refreshUnixKeys();
            break;
        case "token-renewed":
            // Échange du nouveau jeton contre le cookie, puis retour sur la page (adresse propre)
            toast("jeton renouvelé : l'ancien ne fonctionne plus", "ok");
            setTimeout(() => location.replace(`/?token=${msg.token}`), 600);
            break;
        case "token-revoked":
            toast("jeton d'accès renouvelé depuis une autre page : rouvre le deck avec la nouvelle adresse si la connexion ne revient pas");
            break;
        case "update":
            applyUpdate(msg);
            break;
        case "update-progress":
            toast(msg.text, "ok");
            break;
        case "restarting":
            closeSettings();
            toast("redémarrage du deck… (reconnexion automatique)", "ok");
            break;
        case "diagnostic":
            renderDiagnostic(msg.checks);
            break;
        case "backup-list":
            renderBackups(msg.backups);
            break;
        case "backup-restored":
            renderBackups(msg.backups);
            toast(msg.name === "vault.enc" ? "coffre restauré : il est verrouillé, déverrouille-le avec le mot de passe de l'époque"
                : `${msg.name} restauré (la version d'avant est dans les sauvegardes)`, "ok");
            break;
        case "config-export":
            downloadJson(msg.data, `configuration-deck-${new Date().toISOString().slice(0, 10)}.json`, "configuration exportée");
            break;
        case "config-imported":
            $("#config-import-confirm").hidden = true;
            pendingConfig = null;
            toast(`importé : ${msg.done.join(", ") || "rien"}${msg.warnings.length ? ` ; attention : ${msg.warnings.join(" ; ")}` : ""}`, msg.warnings.length ? "ko" : "ok");
            break;
        case "param-options":
            applyParamOptions(msg);
            break;
        case "journal-list":
            renderJournal(msg.entries);
            break;
        case "journal-recent":
            applyRecent(msg.entries);
            break;
        // Enregistrement de sessions
        case "rec":
            state.rec = new Set(msg.sids);
            applyRec();
            break;
        case "rec-started":
            toast(`● enregistrement démarré : ${msg.file}`, "ok");
            break;
        case "rec-stopped": {
            const d = msg.seconds >= 60 ? `${Math.floor(msg.seconds / 60)} min ${msg.seconds % 60} s` : `${msg.seconds} s`;
            toast(`enregistrement terminé (${d}${msg.reason ? `, ${msg.reason}` : ""}) : ${msg.cast} et ${msg.txt} (Réglages › Enregistrements)`, "ok");
            if (!$("#settings").hidden) send({ t: "rec-list" });
            break;
        }
        case "rec-list":
            renderRecordings(msg.files);
            break;
        case "rec-cast":
            startPlayer(msg.name, msg.cast);
            break;
        case "journal-added":
            if (!$("#settings").hidden) send({ t: "journal-list" });
            break;
        case "journal-export": {
            // ﻿ (BOM) : Excel lit les accents correctement
            const url = URL.createObjectURL(new Blob(["\ufeff" + msg.csv], { type: "text/csv;charset=utf-8" }));
            const a = Object.assign(document.createElement("a"), { href: url, download: `journal-deck-${new Date().toISOString().slice(0, 10)}.csv` });
            document.body.append(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            toast(`journal exporté : ${a.download} (dans Téléchargements)`, "ok");
            break;
        }
        case "fav-export":
            downloadJson(msg.data, `favoris-deck-${new Date().toISOString().slice(0, 10)}.json`);
            break;
        case "vault-export":
            downloadJson(msg.data, `coffre-deck-${new Date().toISOString().slice(0, 10)}.json`, "coffre exporté (chiffré)");
            break;
        case "vault-imported": {
            hideVaultImport();
            const n = `${msg.notes} note(s), ${msg.secrets} secret(s)`;
            toast(msg.mode === "merge" ? `coffre fusionné : ${msg.added} ajouté(s), ${msg.updated} mis à jour (fichier : ${n})`
                : msg.mode === "replace" ? `coffre remplacé (${n}) ; il s'ouvre maintenant avec le mot de passe du fichier ; ancien coffre dans vault.enc.bak`
                : `coffre importé et déverrouillé (${n})`, "ok");
            break;
        }
        case "fav-imported": {
            hideImportConfirm();
            const what = `${msg.added} favori(s) ${msg.mode === "replace" ? "importé(s), anciens remplacés" : "ajouté(s)"}`;
            const extra = [msg.duplicates ? `${msg.duplicates} déjà présent(s)` : "", msg.skipped?.length ? `${msg.skipped.length} ignoré(s) : ${msg.skipped[0]}` : ""].filter(Boolean);
            toast(extra.length ? `${what} ; ${extra.join(" ; ")}` : what, msg.skipped?.length ? "ko" : "ok");
            break;
        }
        case "vault-ok":
            toast(msg.text, "ok");
            if (msg.close) closeSecretForm();
            break;
        case "kube-list":
            showKubePicker(msg);
            break;
        case "kube-used":
            closePicker();
            toast("contexte / namespace changé", "ok");
            break;
        case "git-list":
            showGitPicker(msg);
            break;
        case "renamed": {
            const t = state.terms.get(msg.sid);
            if (t) setTitle(t, msg.title);
            break;
        }
        case "order":
            applyOrder(msg.order);
            break;
        case "exit": {
            const t = state.terms.get(msg.sid);
            if (!t) break;
            t.ended = true;
            t.tab.classList.add("ended");
            t.term.write(`\r\n\x1b[90m[terminal fermé, code ${msg.code}]\x1b[0m\r\n`);
            break;
        }
        case "status":
            state.status[msg.id] = msg.state;
            // Contexte kubectl passé en (ou sorti de) production : touches protégées re-dessinées
            if (msg.id === "kube" && (state.pages[state.page] ?? []).some((k) => k?.prodGuard)) render();
            if (msg.id === "kube") updateScreensBanner();
            if (msg.id === "certs") renderCertsPanel();
            document.querySelectorAll(`[data-status="${msg.id}"]`).forEach((el) => el.replaceWith(statusKey(el.dataset.id, msg.id)));
            numberKeys();
            break;
        case "ran":
            flash(msg.id, msg.ok);
            if (!msg.ok) toast(msg.error ?? "échec");
            break;
        case "error":
            // Réglages refusés par le serveur : le panneau revient pour corriger
            if (settingsPending) { settingsPending = false; $("#settings").hidden = false; }
            if (state.update) applyUpdate(state.update);   // bouton Mettre à jour / Vérifier réactivé après une erreur
            if (missionPending) { missionDone(); showMissionError(msg.error); }
            if (actionPending) { actionDone(); showActionError(msg.error); }
            toast(msg.error);
            break;
    }
}

// ---------- Grille ----------

function render() {
    hideKeyTip();
    const grid = $("#grid");
    const { left, right } = rowOrder(state.pages[state.page]);
    // L'espace extensible pousse Verrouiller et clear contre le bord droit de la fenêtre
    const spacer = Object.assign(document.createElement("div"), { className: "spacer" });
    grid.replaceChildren(...left.map(keyElement), spacer, ...right.map(keyElement));
    // Taille des touches : la ligne doit tenir dans la fenêtre (15 cases au moins)
    document.documentElement.style.setProperty("--count", Math.max(15, left.length + right.length));
    numberKeys();
    renderCrumbs();
}

/**
 * Raccourcis clavier : ⌥1…⌥9 puis ⌥0 (Alt sous Windows) pour les dix premières touches d'action de la page,
 * dans l'ordre de l'écran (sans Retour ni clear). Numéros affichés tant que ⌥ est enfoncée.
 */
function numberKeys() {
    const keys = [...$("#grid").querySelectorAll(".key")].filter((el) => !el.classList.contains("back") && !el.classList.contains("clear"));
    for (const el of $("#grid").querySelectorAll(".key [data-sc-num]")) el.remove();
    keys.forEach((el, i) => {
        delete el.dataset.sc;
        if (i > 9) return;
        el.dataset.sc = String((i + 1) % 10);
        el.append(Object.assign(document.createElement("span"), { className: "sc-num", textContent: `${macClient ? "⌥" : "Alt "}${el.dataset.sc}` }));
        el.lastChild.dataset.scNum = "";
    });
}

const dialogOpen = () => ["#settings", "#vault", "#favdialog", "#palette", "#picker", "#duplicate", "#params", "#player"].some((id) => $(id) && !$(id).hidden);

// Phase de capture : avant le terminal (sinon ⌥1 taperait « ¡ » sur macOS)
document.addEventListener("keydown", (ev) => {
    if (ev.key === "Alt") document.body.classList.add("show-sc");
    if (!ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
    const digit = /^Digit(\d)$/.exec(ev.code)?.[1];
    if (digit == null || dialogOpen()) return;
    const el = $("#grid").querySelector(`.key[data-sc="${digit}"]`);
    if (!el) return;
    ev.preventDefault();
    ev.stopPropagation();
    el.click();
}, true);
document.addEventListener("keyup", (ev) => { if (ev.key === "Alt") document.body.classList.remove("show-sc"); }, true);
window.addEventListener("blur", () => document.body.classList.remove("show-sc"));

/**
 * Grille 5 x 3 du serveur -> une ligne : à gauche Retour puis les touches dans l'ordre,
 * à droite (alignés sur le bord) Verrouiller puis clear. Les cases vides disparaissent.
 */
function rowOrder(keys) {
    const present = keys.filter(Boolean);
    const first = present.filter((k) => k.type === "back");
    // À droite : Verrouiller, Modifier / Ajouter des favoris (right), puis clear
    const last = [...present.filter((k) => k.right), ...present.filter((k) => k.type === "clear")];
    const middle = present.filter((k) => !first.includes(k) && !last.includes(k));
    return { left: [...first, ...middle], right: last };
}

/** Texte clair sur fond foncé, foncé sur fond clair. */
function isLight(hex) {
    const n = parseInt(hex.slice(1), 16);
    return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 170;
}

function keyElement(key) {
    if (key.type === "status") return statusKey(key.id, key.status, key);
    const el = document.createElement("button");
    el.className = `key ${key.type}`;
    el.dataset.id = key.id;
    el.style.setProperty("--c", key.color);
    if (isLight(key.color)) el.classList.add("light");
    const cmd = key.type === "text" ? commandFor(key) : null;
    el.title = cmd != null
        ? (cmd.includes("{}") ? cmd.replace("{}", "‹sélection›") : cmd + (key.enter ? "" : "\n+ texte sélectionné dans le terminal"))
        : key.url ?? key.label;

    const sym = document.createElement("span");
    if (key.icon) {
        // Logo SVG monochrome, peint dans la couleur du texte de la touche (masque CSS)
        sym.className = "sym logo";
        sym.style.setProperty("--logo", `url("/icons/${key.icon}.svg")`);
    } else {
        sym.className = `sym${/^[\x20-\x7E]+$/.test(key.sym) ? " ascii" : ""}`;
        sym.textContent = key.sym;
        if (key.sym.length > 3) sym.style.fontSize = `${Math.max(14, 26 - (key.sym.length - 3) * 4)}px`;
    }
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = key.label;
    el.append(sym, label);

    if (key.prodGuard && prodContext()) {
        el.classList.add("prod-guard");
        if (prodArmed?.id === key.id) el.classList.add("armed");
        el.append(Object.assign(document.createElement("span"), { className: "missing-tag prod-tag", textContent: prodArmed?.id === key.id ? "confirmer ?" : "PROD" }));
    }
    if (key.unix && !unixReady()) {
        el.classList.add("unavailable");
        el.append(Object.assign(document.createElement("span"), { className: "missing-tag", textContent: "ssh requis" }));
    } else if (key.needs && localTool(key) && state.tools.missing.has(key.needs)) {
        el.classList.add("missing");
        const install = state.tools.install[key.needs];
        el.title = `${key.needs} n'est pas installé.\n${install ? `Clic : tape « ${install} » (à valider avec Entrée)` : "Installe-le avec le gestionnaire de paquets du système."}`;
        el.append(Object.assign(document.createElement("span"), { className: "missing-tag", textContent: "à installer" }));
    }
    if (key.badge) {
        const badge = document.createElement("span");
        badge.className = `badge ${key.badge}`;
        el.append(badge);
    }
    if (key.fav && state.favEdit) {
        el.classList.add("editing");
        el.title = `Modifier « ${key.label} »`;
    }
    // Favoris : glisser-déposer pour réordonner, entrer dans un groupe ou remonter (sur Retour)
    if (key.fav) favDraggable(el, key);
    if (key.type === "back" && state.page.startsWith("fav-")) favDropOnBack(el);
    if (key.type === "fav-edit") {
        el.classList.toggle("on", state.favEdit);
        el.querySelector(".label").textContent = state.favEdit ? "Terminé" : "Modifier";
    }
    el.addEventListener("click", () => { hideKeyTip(); press(key, el); });
    attachKeyTip(el, key);
    return el;
}

/** Voyant : dessiné à partir du dernier état reçu du serveur. */
function statusKey(id, statusId, key) {
    const s = state.status[statusId] ?? { bg: "#37474F", title: key?.label ?? statusId, lines: ["…"] };
    const el = document.createElement("button");
    el.className = "key status";
    el.dataset.id = id;
    el.dataset.status = statusId;
    el.style.setProperty("--c", s.bg);
    el.title = statusId === "git" ? `${s.repo ?? ""}\nAppui : choisir le dépôt, ouvrir un terminal dedans`
        : statusId === "kube" ? "Appui : changer de contexte ou de namespace"
            : statusId === "certs" ? "Appui : liste de tous les certificats suivis"
            : s.detail ? `${s.detail}\nAppui : vérifier maintenant` : "Appui : rafraîchir";

    const title = Object.assign(document.createElement("span"), { className: "title", textContent: s.title });
    const lines = Object.assign(document.createElement("span"), { className: "lines" });
    for (const text of s.lines) {
        const big = s.lines.length === 1 && text.length <= 4;
        lines.append(Object.assign(document.createElement("span"), { className: `line${big ? " big" : ""}`, textContent: text, title: text }));
    }
    el.append(title, lines);
    if (s.footer) el.append(Object.assign(document.createElement("span"), { className: "footer", textContent: s.footer }));
    el.addEventListener("click", () => {
        pulse(el);
        if (statusId === "kube") return openPicker(el, "kube-list", "Chargement des contextes…");
        if (statusId === "git") return openPicker(el, "git-list", "Chargement des dépôts…");
        if (statusId === "certs") return openCertsPanel(el);
        send({ t: "press", id: statusId });
    });
    return el;
}

/** Fil d'Ariane : Accueil › Favoris › Groupe › Sous-groupe (chaque niveau est cliquable). */
function renderCrumbs() {
    const nav = $("#crumbs");
    const chain = [];
    for (let p = state.page; p; p = p === "root" ? null : state.parents[p] ?? "root") chain.unshift(p);
    nav.replaceChildren(...chain.flatMap((page, i) => {
        const text = page === "root" ? "Accueil" : state.titles[page] ?? page;
        const last = i === chain.length - 1;
        const el = last
            ? Object.assign(document.createElement("span"), { className: "current", textContent: text })
            : Object.assign(document.createElement("button"), { textContent: text });
        if (!last) el.addEventListener("click", () => go(page));
        return i ? [Object.assign(document.createElement("span"), { className: "sep", textContent: "›" }), el] : [el];
    }));
}

const isFavPage = (page) => page === "favoris" || page.startsWith("fav-");

function go(page) {
    state.page = page;
    // Rubrique avec des outils « à installer » : vérification immédiate (installés depuis ?)
    if (state.tools.missing.size && (state.pages[page] ?? []).some((k) => k?.needs && state.tools.missing.has(k.needs))) send({ t: "tools-check" });
    if (!isFavPage(page)) state.favEdit = false;
    if (worldOf(page) !== autoHome.world) cancelAutoHome();   // retour à l'accueil ou autre rubrique
    render();
}

function press(key, el) {
    pulse(el);
    // Action dans une rubrique : (re)lance le compte à rebours du retour à l'accueil
    if (key.type !== "back" && state.page !== "root" && (key.type !== "folder" || isFavPage(key.page))) armAutoHome();
    // Garde-fou production : sur un contexte kubectl de prod, deuxième clic (dans les 5 s) pour confirmer
    if (key.prodGuard && prodContext() && prodArmed?.id !== key.id) return armProdKey(key);
    if (key.prodGuard) disarmProdKey(true);
    // Rubrique Linux / macOS (Ansible) sur un poste Windows : seulement dans un terminal connecté en ssh / wsl
    if (key.unix && !unixReady()) return toast(`${UNIX_HINT} (terminal actif : ${state.terms.size ? "pas de session ssh / wsl" : "aucun"})`);
    // Outil absent : la touche propose son installation au lieu de lancer une commande qui échouerait
    if (key.needs && localTool(key) && state.tools.missing.has(key.needs)) {
        // Gestionnaire de paquets absent (Scoop sous Windows) : on propose d'abord de l'installer
        const manager = state.tools.manager;
        if (manager && !manager.present) {
            const setup = typeof manager.setup === "string" ? manager.setup : manager.setup[activeKind()] ?? manager.setup.powershell;
            send({ t: "tools-check", watch: true });
            toast(`${key.needs} s'installe avec ${manager.name}, absent de ce poste : commande d'installation de ${manager.name} tapée (sans droits admin), valide avec Entrée`, "ok");
            return typeInTerminal(setup);
        }
        const install = state.tools.install[key.needs];
        send({ t: "tools-check", watch: true });   // le serveur surveille l'installation : la touche se rallume à la fin
        if (!install) return toast(`${key.needs} n'est pas installé : installe-le avec le gestionnaire de paquets du système`);
        toast(`${key.needs} n'est pas installé : commande d'installation tapée, valide avec Entrée`, "ok");
        return typeInTerminal(install);
    }
    // Sélecteur de contexte / namespace kubectl (comme le voyant de l'accueil)
    if (key.kubePicker) return openPicker(el ?? document.querySelector(`[data-id="${CSS.escape(key.id)}"]`), "kube-list", "Chargement des contextes…");
    switch (key.type) {
        case "folder": {
            if (key.fav && state.favEdit) return openFavForm(key);
            // Touche Favoris de l'accueil : groupe de la mission active ouvert directement (s'il existe)
            const group = key.page === "favoris" && activeMission()?.favGroup;
            if (group && state.pages[`fav-${group}`]) return go(`fav-${group}`);
            return go(key.page);
        }
        case "back": return go(key.page ?? "root");
        case "web":
            if (key.fav && state.favEdit) return openFavForm(key);
            journalAction(key, key.url, "link");
            return window.open(key.url, "_blank", "noopener,noreferrer");
        case "fav-add": return openFavForm();
        case "vault": return openVault();
        case "fav-edit":
            state.favEdit = !state.favEdit;
            return render();
        case "run": return send({ t: "run", id: key.id });
        case "text": {
            const raw = commandFor(key);
            if (raw == null) return toast(`« ${key.label} » n'existe pas pour le shell ${activeKind()}`);
            // Variables de la mission active : {mission.registry} -> harbor.client.fr
            let command, pickCommand;
            try {
                command = withMissionVars(raw);
                pickCommand = key.pick ? withMissionVars(key.pick) : null;
            } catch (err) {
                return toast(err.message);
            }
            // Paramètres nommés ({namespace}, {pod}…) : fenêtre de saisie avant de taper la commande
            if (namedParams(command).length) return openParams(key, command);
            // Touche intégrée (logs -f, exec -it…) sans rien de sélectionné : choix dans la liste réelle (pods, conteneurs)
            if (pickCommand && !hasPendingSelection()) return openParams(key, pickCommand);
            if (key.enter) {
                journalAction(key, command, "run");
                return typeInTerminal(command + "\r");
            }
            // Commande à compléter : le texte sélectionné dans le terminal est ajouté à la fin (sans Entrée)
            const typed = withSelection(command);
            journalAction(key, typed, "type");
            return typeInTerminal(typed);
        }
        case "clear": {
            const t = state.terms.get(state.active);
            t?.term.clear();
            // Ctrl+L efface aussi côté shell (PowerShell, bash, zsh) ; cmd ne connaît que "cls"
            return typeInTerminal(activeKind() === "cmd" ? "cls\r" : "\x0c");
        }
    }
}

// ---------- Infobulles des touches : ce que fait l'action (bref), la commande, le comportement ----------

let keyTipTimer = null;

/** Contenu de l'infobulle d'une touche, ou null. */
function keyTipContent(key) {
    if (key.fav && state.favEdit) return { desc: `Modifier « ${key.label} »`, cmd: null, how: "Glisser pour déplacer" };
    const desc = key.desc
        ?? (key.type === "folder" ? (key.favGroup ? `Groupe ${key.label}` : `Rubrique ${key.label}`)
        : key.type === "back" ? "Revient en arrière"
        : key.type === "clear" ? "Efface le terminal actif"
        : key.type === "fav-add" ? "Ajoute un site ou un groupe"
        : key.type === "fav-edit" ? (state.favEdit ? "Termine la modification" : "Modifie, déplace ou supprime les favoris")
        : key.type === "web" ? key.label
        : null);
    const cmd = key.type === "text" ? commandFor(key) : key.type === "web" ? key.url : null;
    let how = null;
    if (key.prodGuard && prodContext()) how = `PRODUCTION (${prodContext()}) : deuxième clic pour confirmer`;
    else if (key.unix && !unixReady()) how = UNIX_HINT;
    else if (key.needs && localTool(key) && state.tools.missing.has(key.needs)) {
        const m = state.tools.manager;
        how = m && !m.present ? `${key.needs} n'est pas installé, ${m.name} non plus : clic = installer ${m.name} d'abord` : `${key.needs} n'est pas installé : clic = commande d'installation`;
    }
    else if (key.type === "text" && cmd != null && key.pick) how = "Texte sélectionné utilisé ; sinon, choix dans la liste réelle";
    else if (key.type === "text" && cmd != null) how = key.enter ? "Exécutée tout de suite" : cmd.includes("{}") ? "À compléter : le texte sélectionné va à la place de ‹…›" : "À compléter (+ texte sélectionné), Entrée pour lancer";
    else if (key.type === "web") how = "Ouvre un onglet";
    if (!desc && !cmd) return null;
    return { desc: desc ?? key.label, cmd: cmd?.replace("{}", "‹…›"), how };
}

function attachKeyTip(el, key) {
    el.removeAttribute("title");   // pas d'infobulle native en double
    el.addEventListener("mouseenter", () => {
        clearTimeout(keyTipTimer);
        keyTipTimer = setTimeout(() => showKeyTip(el, key), 350);
    });
    el.addEventListener("mouseleave", hideKeyTip);
    el.addEventListener("dragstart", hideKeyTip);
}

function showKeyTip(el, key) {
    const tip = $("#keytip");
    const c = keyTipContent(key);
    if (!c || !el.isConnected) return;
    tip.replaceChildren(
        Object.assign(document.createElement("strong"), { textContent: c.desc }),
        ...(c.cmd ? [Object.assign(document.createElement("code"), { textContent: c.cmd.length > 90 ? `${c.cmd.slice(0, 89)}…` : c.cmd })] : []),
        ...(c.how ? [Object.assign(document.createElement("span"), { className: "keytip-how", textContent: c.how })] : [])
    );
    tip.hidden = false;
    // Sous la touche, centrée, sans sortir de la fenêtre
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth;
    tip.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
    tip.style.top = `${r.bottom + 8}px`;
}

function hideKeyTip() {
    clearTimeout(keyTipTimer);
    $("#keytip").hidden = true;
}

// ---------- Paramètres nommés : {namespace}, {pod}, {durée}… (fenêtre de saisie, dernières valeurs, listes réelles) ----------

// {nom} ou {nom=valeur par défaut} (ex. {durée=15m}, {local=8080})
const PARAM_RE = /\{([\p{L}_][\p{L}\p{N}_-]{0,30})(?:=([^{}\r\n]{0,80}))?\}/gu;
const SENSITIVE_PARAM = /pass|secret|token|mdp|pwd|key|cle|clé/i;   // jamais gardés dans l'historique
const LIVE = ["namespace", "ns", "pod", "deployment", "deploy", "service", "svc", "node", "context", "ctx", "contexte", "container", "conteneur", "image", "host", "hote", "hôte", "serveur", "server", "identity", "identite", "identité", "port"];
let paramsState = null;   // { key, command, names, req }

/** Paramètres nommés d'une commande, dans l'ordre, sans doublon. */
const namedParams = (command) => [...new Set([...String(command).matchAll(PARAM_RE)].map((m) => m[1]))];

/** Valeurs par défaut écrites dans la commande ({nom=valeur}) ; la première trouvée pour chaque nom. */
function paramDefaults(command) {
    const out = {};
    for (const m of String(command).matchAll(PARAM_RE)) if (m[2] != null && !(m[1] in out)) out[m[1]] = m[2].trim();
    return out;
}

function paramHistory(name) {
    try { return JSON.parse(localStorage.getItem(`deck-param-${name.toLowerCase()}`) ?? "[]"); } catch { return []; }
}

function rememberParam(name, value) {
    if (!value || SENSITIVE_PARAM.test(name)) return;
    const list = [value, ...paramHistory(name).filter((v) => v !== value)].slice(0, 10);
    try { localStorage.setItem(`deck-param-${name.toLowerCase()}`, JSON.stringify(list)); } catch { /* stockage indisponible */ }
}

const isNs = (name) => /^(namespace|ns)$/i.test(name);
const isSvc = (name) => /^(service|svc)$/i.test(name);
const NAMESPACED = /^(pod|deployment|deploy|service|svc)$/i;
const PARAM_NOUN = { pod: "pod", deployment: "deployment", deploy: "deployment", service: "service", svc: "service" };

function openParams(key, command) {
    const names = namedParams(command);
    paramsState = { key, command, names, req: crypto.randomUUID(), options: new Map() };
    const defaults = paramDefaults(command);
    // Sélection du terminal (ou d'une note) : proposée pour le premier paramètre
    const terms = [state.terms.get(state.active), ...state.terms.values()].filter(Boolean);
    const t = terms.find((x) => !x.ended && x.term.hasSelection());
    const selected = (t ? t.term.getSelection() : noteSelection?.text ?? "").replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();
    if (t) t.term.clearSelection();
    noteSelection = null;
    const kube = state.status.kube;
    $("#params-title").textContent = key.label;
    $("#params-fields").replaceChildren(...names.map((name, i) => {
        const id = `param-${i}`;
        const label = Object.assign(document.createElement("label"), { className: "param-field", textContent: name });
        const input = Object.assign(document.createElement("input"), { id, type: SENSITIVE_PARAM.test(name) ? "password" : "text", spellcheck: false, autocomplete: "off" });
        input.dataset.name = name;
        input.setAttribute("role", "combobox");
        // Valeur de départ : la sélection pour le premier, le namespace courant pour {namespace}
        input.value = i === 0 && selected ? selected : isNs(name) && kube?.namespace ? kube.namespace : defaults[name] ?? "";
        input.dataset.filter = "";   // pas de filtre tant que l'utilisateur n'a pas tapé : toute la liste est visible
        const list = Object.assign(document.createElement("ul"), { className: "param-options", hidden: true });
        list.setAttribute("role", "listbox");
        const status = Object.assign(document.createElement("span"), { className: "hint param-status" });
        input.addEventListener("focus", () => showParamOptions(input));
        input.addEventListener("click", () => showParamOptions(input));
        input.addEventListener("blur", () => setTimeout(() => { list.hidden = true; }, 120));
        input.addEventListener("input", () => {
            input.dataset.filter = input.value;
            renderParamsPreview();
            showParamOptions(input);
            if (isNs(name) || isSvc(name)) { clearTimeout(input._t); input._t = setTimeout(() => loadLiveParams(isNs(name) ? "ns" : "svc"), 400); }
        });
        input.addEventListener("keydown", (ev) => paramKey(ev, input));
        label.append(input, list, status);
        if (!LIVE.includes(name.toLowerCase())) setParamOptions(input, paramHistory(name), "");
        return label;
    }));
    $("#params-error").hidden = true;
    $("#params-ok").textContent = key.enter ? "Lancer" : "Taper";
    $("#params").hidden = false;
    renderParamsPreview();
    loadLiveParams(false);
    // Premier champ à remplir (vide de préférence) ; le namespace déjà rempli passe directement au pod
    const inputs = [...$("#params-fields").querySelectorAll("input")];
    const target = inputs.find((x) => !x.value) ?? inputs[0];
    target?.focus();
    if (target?.value) target.select();
}

/**
 * Listes réelles pour les paramètres connus. after = "ns" : namespace changé (pods, services… et ports
 * rechargés) ; "svc" : service changé (ports rechargés) ; sinon toutes.
 */
function loadLiveParams(after = null) {
    const inputs = [...$("#params-fields").querySelectorAll("input")];
    const ns = inputs.find((i) => isNs(i.dataset.name))?.value.trim() ?? "";
    const service = inputs.find((i) => isSvc(i.dataset.name))?.value.trim() ?? "";
    for (const input of inputs) {
        const name = input.dataset.name;
        if (!LIVE.includes(name.toLowerCase())) continue;
        const isPort = /^port$/i.test(name);
        if (after === "ns" && !NAMESPACED.test(name) && !isPort) continue;
        if (after === "svc" && !isPort) continue;
        if (isPort && !service) { setParamOptions(input, [], "choisis d'abord le service"); continue; }
        setParamOptions(input, null, "chargement de la liste…");
        send({ t: "param-options", req: paramsState.req, name, namespace: ns, service });
    }
}

function applyParamOptions(msg) {
    if (!paramsState || msg.req !== paramsState.req) return;
    const ns = [...$("#params-fields").querySelectorAll("input")].find((i) => isNs(i.dataset.name))?.value.trim();
    for (const input of $("#params-fields").querySelectorAll("input")) {
        if (input.dataset.name !== msg.name) continue;
        // Liste réelle, valeurs récemment utilisées en tête (seulement celles qui existent encore)
        const recent = paramHistory(msg.name).filter((v) => msg.options.includes(v));
        const options = [...recent, ...msg.options.filter((o) => !recent.includes(o))];
        const noun = PARAM_NOUN[msg.name.toLowerCase()];
        const status = msg.error ? `liste indisponible : ${msg.error} (saisie libre possible)`
            : !options.length && noun && ns ? `aucun ${noun} dans le namespace « ${ns} » : choisis un autre namespace`
            : !options.length ? "liste vide (saisie libre possible)"
            : `${options.length} valeur(s) : clique ou ↑ ↓ puis Entrée`;
        setParamOptions(input, options, status, !options.length && !msg.error);
    }
}

/** Mémorise les valeurs d'un champ et son état ; la liste est réaffichée si le champ a le focus. */
function setParamOptions(input, options, status, warn = false) {
    if (options) paramsState.options.set(input.id, options);
    const el = input.parentElement.querySelector(".param-status");
    el.textContent = status;
    el.classList.toggle("warn", warn);
    if (document.activeElement === input) showParamOptions(input);
}

/** Affiche les valeurs proposées, filtrées par le texte tapé (sans casse ni accents). */
function showParamOptions(input) {
    const list = input.parentElement.querySelector(".param-options");
    const filter = fold(input.dataset.filter ?? "");
    const options = (paramsState?.options.get(input.id) ?? []).filter((o) => fold(o).includes(filter)).slice(0, 200);
    list.replaceChildren(...options.map((o, i) => {
        const li = Object.assign(document.createElement("li"), { textContent: o, className: i === 0 && filter ? "sel" : "" });
        li.setAttribute("role", "option");
        li.addEventListener("mousedown", (ev) => { ev.preventDefault(); pickParam(input, o); });
        return li;
    }));
    list.hidden = !options.length;
}

/** Valeur choisie : champ rempli, liste fermée, champ suivant (ou bouton) ; un namespace recharge les pods. */
function pickParam(input, value) {
    input.value = value;
    input.dataset.filter = "";
    input.parentElement.querySelector(".param-options").hidden = true;
    renderParamsPreview();
    if (isNs(input.dataset.name)) loadLiveParams("ns");
    else if (isSvc(input.dataset.name)) loadLiveParams("svc");
    const inputs = [...$("#params-fields").querySelectorAll("input")];
    const next = inputs.slice(inputs.indexOf(input) + 1).find((x) => !x.value) ?? null;
    (next ?? $("#params-ok")).focus();
}

/** Flèches : parcourir la liste ; Entrée : choisir la valeur surlignée ; Échap : fermer la liste d'abord. */
function paramKey(ev, input) {
    const list = input.parentElement.querySelector(".param-options");
    const items = [...list.children];
    const cur = items.findIndex((li) => li.classList.contains("sel"));
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        if (list.hidden) return showParamOptions(input);
        if (!items.length) return;
        const next = ev.key === "ArrowDown" ? (cur + 1) % items.length : (cur <= 0 ? items.length : cur) - 1;
        items.forEach((li, i) => li.classList.toggle("sel", i === next));
        items[next].scrollIntoView({ block: "nearest" });
    } else if (ev.key === "Enter" && !list.hidden && cur >= 0) {
        ev.preventDefault();
        pickParam(input, items[cur].textContent);
    } else if (ev.key === "Escape" && !list.hidden) {
        ev.preventDefault();
        ev.stopPropagation();
        list.hidden = true;
    }
}

/** Commande avec les valeurs saisies (caractères de contrôle retirés ; un paramètre vide reste {nom}). */
function paramsCommand() {
    let cmd = paramsState.command;
    for (const input of $("#params-fields").querySelectorAll("input")) {
        const value = input.value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
        const name = input.dataset.name;
        // {nom} et {nom=défaut} remplacés partout (ex. {port}:{port})
        cmd = cmd.replace(PARAM_RE, (all, n) => (n === name ? value || `{${name}}` : all));
    }
    return cmd;
}

function renderParamsPreview() {
    if (!paramsState) return;
    const masked = [...$("#params-fields").querySelectorAll("input")].reduce((cmd, i) => (i.type === "password" && i.value ? cmd.split(i.value).join("••••") : cmd), paramsCommand());
    $("#params-preview").textContent = masked;
}

function submitParams() {
    const inputs = [...$("#params-fields").querySelectorAll("input")];
    const empty = inputs.find((i) => !i.value.trim());
    if (empty) {
        $("#params-error").textContent = `« ${empty.dataset.name} » est vide`;
        $("#params-error").hidden = false;
        return empty.focus();
    }
    const { key } = paramsState;
    const command = paramsCommand();
    for (const i of inputs) rememberParam(i.dataset.name, i.value.trim());
    closeParams();
    journalAction(key, command, key.enter ? "run" : "type");
    typeInTerminal(key.enter ? `${command}\r` : command);
}

function closeParams() {
    $("#params").hidden = true;
    paramsState = null;
    state.terms.get(state.active)?.term.focus();
}

/** Journal des actions (côté serveur, qui ajoute le contexte kubectl) : touche, commande, exécutée ou tapée. */
function journalAction(key, command, mode) {
    if (state.settings?.journalEnabled === false) return;
    send({ t: "journal", label: key.label, page: state.titles[state.page] ?? state.page, command, mode, sid: state.active });
}

function renderJournal(entries) {
    const list = $("#journal-list");
    if (!entries.length) {
        list.replaceChildren(Object.assign(document.createElement("li"), { className: "hint", textContent: state.settings?.journalEnabled === false ? "journal désactivé" : "aucune action notée pour l'instant" }));
        return;
    }
    list.replaceChildren(...entries.slice(0, 60).map((e) => {
        const li = document.createElement("li");
        if (e.prod) li.classList.add("prod");
        const time = new Date(e.time);
        li.append(
            Object.assign(document.createElement("span"), { className: "j-time", textContent: `${time.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" })} ${time.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}` }),
            Object.assign(document.createElement("strong"), { textContent: e.label, title: e.page }),
            Object.assign(document.createElement("code"), { textContent: e.command, title: `${e.mode}${e.terminal ? ` · ${e.terminal}` : ""}` }),
            Object.assign(document.createElement("span"), { className: "j-kube", textContent: e.prod ? `PROD ${e.kube ?? ""}` : e.kube ?? "" }));
        return li;
    }));
}

function pulse(el) {
    if (!el) return;
    el.classList.add("pressed");
    setTimeout(() => el.classList.remove("pressed"), 120);
}

function flash(id, ok) {
    const el = document.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!el) return;
    el.classList.remove("ok", "ko");
    void el.offsetWidth;   // relance l'animation
    el.classList.add(ok ? "ok" : "ko");
}

let toastTimer;
function toast(text, kind = "ko") {
    const el = $("#toast");
    el.textContent = text;
    el.classList.toggle("ok", kind === "ok");
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 4000);
}

/**
 * Ajoute à une commande à compléter le texte sélectionné dans le terminal (actif en priorité), puis efface la sélection.
 * Retours à la ligne et caractères de contrôle deviennent des espaces : une sélection ne peut jamais lancer la commande.
 */
function withSelection(command) {
    const terms = [state.terms.get(state.active), ...state.terms.values()].filter(Boolean);
    const t = terms.find((x) => !x.ended && x.term.hasSelection());
    let selected = "";
    if (t) {
        selected = t.term.getSelection().replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();
        t.term.clearSelection();
    } else if (noteSelection && Date.now() - noteSelection.time < NOTE_SELECTION_MS) {
        // Pas de sélection dans le terminal : celle faite dans une note du coffre (une seule fois)
        selected = noteSelection.text;
    }
    noteSelection = null;
    // {} : la sélection va à cet endroit ; sans sélection, le curseur y est ramené (flèches gauche)
    const slot = command.indexOf("{}");
    if (slot >= 0) {
        const before = command.slice(0, slot);
        const after = command.slice(slot + 2);
        return selected ? before + selected + after : before + after + "\x1b[D".repeat(after.length);
    }
    if (!selected) return command;
    const sep = /[\s"'=:]$/.test(command) ? "" : " ";
    return command + sep + selected;
}

/** Remplace {mission.nom} par la valeur de la mission active ; erreur claire si elle manque. */
function withMissionVars(command) {
    return command.replace(/\{mission\.([A-Za-z][A-Za-z0-9_-]{0,30})\}/g, (_, name) => {
        const mission = activeMission();
        if (!mission) throw new Error(`{mission.${name}} : aucune mission active (choisis-en une en haut à droite)`);
        const value = mission.vars?.[name];
        if (value == null || value === "") throw new Error(`{mission.${name}} : variable absente de la mission « ${mission.name} » (Réglages › Missions › Modifier)`);
        return value;
    });
}

/** Texte sélectionné en attente : dans un terminal, ou gardé depuis une note du coffre. */
function hasPendingSelection() {
    if ([...state.terms.values()].some((x) => !x.ended && x.term.hasSelection())) return true;
    return Boolean(noteSelection && Date.now() - noteSelection.time < NOTE_SELECTION_MS);
}

/** Famille du shell qui recevra la commande : onglet actif, sinon celui qu'ouvrira la page. */
function activeKind() {
    const t = state.terms.get(state.active);
    if (t && !t.ended) return t.kind;
    return state.shells[Number($("#shell").value || 0)]?.kind ?? "posix";
}

/** Commande d'une touche "text" pour le shell actif (chaîne commune ou variante par shell) ; null si absente. */
function commandFor(key) {
    return typeof key.text === "string" ? key.text : key.text?.[activeKind()] ?? null;
}

// ---------- Terminaux ----------

function fillShells(shells) {
    state.shells = shells;
    const select = $("#shell");
    const current = select.value;
    select.replaceChildren(...shells.map((s, i) => new Option(s.name, String(i))));
    if (current && Number(current) < shells.length) select.value = current;
    select.hidden = shells.length < 2;
}

function openTerm(cwd) {
    const { cols, rows } = estimateSize();
    send({ t: "open", shell: Number($("#shell").value || 0), cols, rows, req: requestId, ...(cwd ? { cwd } : {}) });
}

/** Taille du terminal avant sa création, d'après la zone disponible (cellule ~9 x 17 px ; un quart en grille). */
function estimateSize() {
    const box = $("#screens").getBoundingClientRect();
    const { cols, rows } = layout();
    return { cols: Math.max(20, Math.floor((box.width / cols - 12) / 9)), rows: Math.max(5, Math.floor((box.height / rows - 12) / 17)) };
}

function addTerm(sid, name, kind = "posix", replay = "", title = null) {
    const term = new Terminal({
        cursorBlink: true,
        fontFamily: "'Cascadia Mono', Consolas, 'SF Mono', Menlo, Monaco, 'DejaVu Sans Mono', monospace",
        fontSize: state.fontSize,
        scrollback: 5000,
        theme: termTheme(),
        allowTransparency: true,
        ...(state.windowsPty ? { windowsPty: state.windowsPty } : {})
    });
    clipboardKeys(term);
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((ev, uri) => window.open(uri, "_blank", "noopener,noreferrer")));
    const search = new SearchAddon();
    term.loadAddon(search);

    const screen = Object.assign(document.createElement("div"), { className: "screen" });
    // Grille : un clic dans un terminal le rend actif (c'est lui qui reçoit les touches)
    screen.addEventListener("mousedown", () => { if (state.active !== sid) activate(sid); });
    $("#screens").append(screen);
    term.open(screen);
    if (replay) term.write(replay);
    // Diffusion : ce qui est tapé dans un terminal visible part dans tous les terminaux visibles
    term.onData((d) => {
        for (const target of inputTargets(sid)) send({ t: "in", sid: target, d });
    });
    term.onResize(({ cols, rows }) => send({ t: "resize", sid, cols, rows }));

    const tab = document.createElement("div");
    tab.className = "tab";
    tab.setAttribute("role", "tab");
    tab.draggable = true;
    tab.dataset.sid = sid;
    const label = Object.assign(document.createElement("span"), { className: "tab-title", title: "Double-clic : renommer · glisser : déplacer" });
    label.addEventListener("dblclick", (ev) => {
        ev.stopPropagation();
        startRename(sid);
    });
    const close = Object.assign(document.createElement("button"), { className: "close", textContent: "×", title: "Fermer ce terminal" });
    close.addEventListener("click", (ev) => {
        ev.stopPropagation();
        closeTerm(sid);
    });
    tab.append(label, close);
    tab.addEventListener("click", () => activate(sid));
    dragTab(tab, sid);
    $("#tabs").append(tab);

    const t = { term, fit, search, tab, label, screen, ended: false, kind, defaultTitle: `${name} ${sid}`, burstStart: 0, lastOut: 0 };
    state.terms.set(sid, t);
    setTitle(t, title);
}

// ---------- Noms et ordre des terminaux (enregistrés côté serveur, partagés entre les pages) ----------

/** Affiche le nom choisi, ou le nom par défaut "shell n°". */
function setTitle(t, title) {
    t.title = title || null;
    const text = t.title ?? t.defaultTitle;
    t.label.textContent = text;
    t.screen.dataset.title = text;
}

/** Remplace le nom de l'onglet par un champ : Entrée valide, Échap annule, vide = nom par défaut. */
function startRename(sid) {
    const t = state.terms.get(sid);
    if (!t || t.tab.querySelector("input")) return;
    const input = Object.assign(document.createElement("input"), {
        className: "tab-rename",
        value: t.title ?? "",
        placeholder: t.defaultTitle,
        maxLength: 40,
        spellcheck: false
    });
    input.size = Math.max(6, input.value.length + 1);
    let done = false;
    const finish = (save) => {
        if (done) return;
        done = true;
        if (save && input.value.trim() !== (t.title ?? "")) send({ t: "rename", sid, title: input.value });
        input.replaceWith(t.label);
        t.tab.draggable = true;
        if (sid === state.active) t.term.focus();
    };
    input.addEventListener("keydown", (ev) => {
        ev.stopPropagation();
        // preventDefault : sinon la touche Entrée "traverse" vers le terminal qui reprend le focus et l'exécute
        if (ev.key === "Enter" || ev.key === "Escape") ev.preventDefault();
        if (ev.key === "Enter") finish(true);
        if (ev.key === "Escape") finish(false);
    });
    input.addEventListener("input", () => { input.size = Math.max(6, input.value.length + 1); });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("click", (ev) => ev.stopPropagation());
    t.tab.draggable = false;   // sinon la sélection de texte dans le champ lance un glisser
    t.label.replaceWith(input);
    input.focus();
    input.select();
}

/** Glisser-déposer des onglets : déposé sur la moitié gauche d'un onglet = avant lui, moitié droite = après. */
function dragTab(tab, sid) {
    tab.addEventListener("dragstart", (ev) => {
        ev.dataTransfer.setData("text/x-deck-sid", sid);
        ev.dataTransfer.effectAllowed = "move";
        tab.classList.add("dragging");
    });
    tab.addEventListener("dragend", () => {
        tab.classList.remove("dragging");
        clearDropMarks();
    });
    tab.addEventListener("dragover", (ev) => {
        if (!ev.dataTransfer.types.includes("text/x-deck-sid")) return;
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "move";
        const after = isAfter(ev, tab);
        clearDropMarks();
        tab.classList.add(after ? "drop-after" : "drop-before");
    });
    tab.addEventListener("dragleave", () => tab.classList.remove("drop-before", "drop-after"));
    tab.addEventListener("drop", (ev) => {
        const moved = ev.dataTransfer.getData("text/x-deck-sid");
        clearDropMarks();
        if (!moved || moved === sid) return;
        ev.preventDefault();
        const ids = [...state.terms.keys()];
        const before = isAfter(ev, tab) ? ids[ids.indexOf(sid) + 1] ?? null : sid;
        if (before === moved) return;
        send({ t: "move", sid: moved, before });
    });
}

const isAfter = (ev, el) => {
    const box = el.getBoundingClientRect();
    return ev.clientX > box.left + box.width / 2;
};
const clearDropMarks = () => document.querySelectorAll(".tab.drop-before, .tab.drop-after").forEach((el) => el.classList.remove("drop-before", "drop-after"));

/** Nouvel ordre reçu du serveur : onglets et terminaux réordonnés (la grille suit cet ordre). */
function applyOrder(order) {
    const known = order.filter((sid) => state.terms.has(sid));
    const rest = [...state.terms.keys()].filter((sid) => !known.includes(sid));
    const terms = new Map([...known, ...rest].map((sid) => [sid, state.terms.get(sid)]));
    state.terms = terms;
    for (const t of terms.values()) {
        $("#tabs").append(t.tab);
        $("#screens").append(t.screen);
    }
    layoutScreens();
}

/**
 * Hors macOS : Ctrl+C copie s'il y a une sélection (sinon interrompt la commande), Ctrl+Shift+C copie,
 * Ctrl+V et Ctrl+Shift+V collent (comme Windows Terminal). Sous macOS, Cmd+C / Cmd+V suffisent.
 */
function clipboardKeys(term) {
    if (macClient) return;
    term.attachCustomKeyEventHandler((ev) => {
        if (ev.type !== "keydown" || !ev.ctrlKey || ev.altKey || ev.metaKey) return true;
        const key = ev.key.toLowerCase();
        if (key === "c" && (ev.shiftKey || term.hasSelection())) {
            ev.preventDefault();
            if (term.hasSelection()) navigator.clipboard?.writeText(term.getSelection()).catch(() => toast("copie refusée par le navigateur"));
            term.clearSelection();
            return false;
        }
        // Laisse le navigateur déclencher l'événement "paste", que xterm.js transmet au shell
        if (key === "v") return false;
        return true;
    });
}

function activate(sid) {
    const t = state.terms.get(sid);
    if (!t) return;
    state.active = sid;
    for (const [id, other] of state.terms) {
        other.tab.classList.toggle("active", id === sid);
        other.screen.classList.toggle("active", id === sid);
    }
    layoutScreens();
    applyRec();          // bouton ● REC selon le terminal actif
    refreshUnixKeys();   // Ansible sous Windows : touches actives seulement dans un terminal connecté
    // Pas de vol du focus si un nom d'onglet est en cours de saisie (double-clic = clic + renommage)
    requestAnimationFrame(() => { if (!document.activeElement?.classList.contains("tab-rename")) t.term.focus(); });
}

/** Terminaux affichés : l'actif en mode onglets ; en grille, les N premiers (l'actif remplace le dernier s'il est plus loin). */
function visibleTerms() {
    const { size } = layout();
    if (size === 1) return state.active ? [state.active] : [];
    const shown = [...state.terms.keys()].slice(0, size);
    if (state.active && !shown.includes(state.active)) shown.splice(size - 1, 1, state.active);
    return shown;
}

function layoutScreens() {
    const { size, cols, rows } = layout();
    const screens = $("#screens");
    screens.classList.toggle("grid", size > 1);
    screens.style.setProperty("--cols", cols);
    screens.style.setProperty("--rows", rows);
    for (const btn of document.querySelectorAll("#layouts button")) {
        const on = btn.dataset.layout === state.layout;
        btn.classList.toggle("on", on);
        btn.setAttribute("aria-pressed", String(on));
    }
    const shown = visibleTerms();
    for (const [id, t] of state.terms) {
        t.screen.classList.toggle("shown", shown.includes(id));
        if (shown.includes(id)) t.tab.classList.remove("activity", "done");
    }
    screens.classList.toggle("broadcast", state.broadcast);
    updateScreensBanner();
    requestAnimationFrame(fitVisible);
}

/**
 * Bandeau des terminaux : PRODUCTION (contexte kubectl de prod, bord rouge) et DIFFUSION (nombre de terminaux
 * qui reçoivent la frappe). Mis à jour au changement de contexte, de disposition ou de diffusion.
 */
function updateScreensBanner() {
    const screens = $("#screens");
    const prod = prodContext();
    screens.classList.toggle("prod", Boolean(prod));
    const parts = [];
    if (prod) parts.push(Object.assign(document.createElement("span"), { className: "banner-prod", textContent: `PRODUCTION · ${prod}` }));
    const recorded = visibleTerms().filter((id) => state.rec?.has(id)).length;
    if (recorded) parts.push(Object.assign(document.createElement("span"), { className: "banner-rec", textContent: recorded > 1 ? `● REC · ${recorded} terminaux` : "● REC" }));
    if (state.broadcast) {
        const n = visibleTerms().filter((id) => !state.terms.get(id)?.ended).length;
        parts.push(Object.assign(document.createElement("span"), { className: "banner-broadcast", textContent: n > 1 ? `DIFFUSION → ${n} terminaux` : "DIFFUSION (un seul terminal visible)" }));
    }
    const banner = $("#screens-banner");
    banner.replaceChildren(...parts);
    banner.hidden = !parts.length;
}

function fitVisible() {
    for (const id of visibleTerms()) state.terms.get(id)?.fit.fit();
}

/** Change de disposition ; ouvre les terminaux manquants pour remplir la grille. */
function setLayout(name) {
    if (!(name in LAYOUTS)) return;
    state.layout = name;
    saveLayout();
    layoutScreens();
    if (layout().size > 1) fillGrid();
}

function fillGrid() {
    const missing = layout().size - [...state.terms.values()].filter((t) => !t.ended).length;
    for (let i = 0; i < missing; i++) openTerm();
}

function closeTerm(sid) {
    const t = state.terms.get(sid);
    if (!t) return;
    if (!t.ended) send({ t: "close", sid });
    removeTerm(sid);
    const next = [...state.terms.keys()].at(-1);
    if (next) activate(next);
    else state.active = null;
}

function removeTerm(sid) {
    const t = state.terms.get(sid);
    if (!t) return;
    t.term.dispose();
    t.tab.remove();
    t.screen.remove();
    state.terms.delete(sid);
    layoutScreens();
}

/** Envoie un texte au terminal actif (en ouvre un s'il n'y en a pas, ou s'il est fermé). */
function typeInTerminal(text) {
    const t = state.terms.get(state.active);
    if (!t || t.ended) {
        state.pending.push(text);
        openTerm();
        return;
    }
    for (const target of inputTargets(state.active)) send({ t: "in", sid: target, d: text });
    t.term.focus();
}

/** Terminaux qui reçoivent une saisie : celui d'origine, ou tous les visibles si la diffusion est active. */
function inputTargets(sid) {
    if (!state.broadcast) return [sid];
    const visible = visibleTerms().filter((id) => !state.terms.get(id)?.ended);
    return visible.includes(sid) ? visible : [sid];
}

// ---------- Activité des terminaux et notifications ----------

const QUIET_MS = 4000;      // silence après lequel une commande est considérée terminée
const LONG_MS = 10000;      // durée à partir de laquelle une commande est "longue"

/** Sortie reçue : point d'activité sur l'onglet si le terminal est caché ; mesure de la durée de la commande. */
function trackActivity(sid, t) {
    const now = Date.now();
    if (now - t.lastOut > QUIET_MS) t.burstStart = now;
    t.lastOut = now;
    if (!visibleTerms().includes(sid)) t.tab.classList.add("activity");
}

/** Commande longue terminée : onglet en vert s'il est caché, notification si la page n'est pas regardée. */
setInterval(() => {
    const now = Date.now();
    for (const [sid, t] of state.terms) {
        if (!t.burstStart || now - t.lastOut < QUIET_MS) continue;
        const long = t.lastOut - t.burstStart >= LONG_MS;
        t.burstStart = 0;
        if (!long) continue;
        const hidden = !visibleTerms().includes(sid);
        if (hidden) {
            t.tab.classList.remove("activity");
            t.tab.classList.add("done");
        }
        if (state.notify && (hidden || document.hidden) && "Notification" in window && Notification.permission === "granted") {
            const n = new Notification(`Deck : « ${t.title ?? t.defaultTitle} » a terminé`, { body: "La commande ne produit plus de sortie.", icon: "/img/icon-64.png", tag: `deck-${sid}` });
            n.onclick = () => { window.focus(); activate(sid); n.close(); };
        }
    }
}, 1500);

async function toggleNotify() {
    if (!state.notify) {
        if (!("Notification" in window)) return toast("notifications non prises en charge par ce navigateur");
        const perm = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
        if (perm !== "granted") return toast("notifications refusées : à autoriser dans les réglages du navigateur pour ce site");
    }
    state.notify = !state.notify;
    savePref("deck-notify", state.notify ? "1" : "0");
    refreshToolbar();
    toast(state.notify ? "notifications activées pour les commandes longues" : "notifications désactivées", "ok");
}

function toggleBroadcast() {
    state.broadcast = !state.broadcast;
    refreshToolbar();
    layoutScreens();
    if (state.broadcast && visibleTerms().length < 2) toast("diffusion active : passe en 2×1 ou 2×2 pour taper dans plusieurs terminaux", "ok");
}

// ---------- Taille du texte ----------

function setFontSize(size) {
    state.fontSize = Math.min(28, Math.max(9, size));
    savePref("deck-font", String(state.fontSize));
    for (const t of state.terms.values()) t.term.options.fontSize = state.fontSize;
    requestAnimationFrame(fitVisible);
}

// ---------- Recherche dans le terminal actif ----------

function openSearch() {
    const bar = $("#searchbar");
    bar.hidden = false;
    const input = $("#search-input");
    const selected = state.terms.get(state.active)?.term.getSelection();
    if (selected && !selected.includes("\n")) input.value = selected;
    input.focus();
    input.select();
}

function closeSearch() {
    $("#searchbar").hidden = true;
    const t = state.terms.get(state.active);
    t?.search.clearDecorations();
    t?.term.clearSelection();
    t?.term.focus();
}

function runSearch(backwards = false) {
    const t = state.terms.get(state.active);
    const query = $("#search-input").value;
    if (!t || !query) return;
    const opts = { caseSensitive: false };
    const found = backwards ? t.search.findPrevious(query, opts) : t.search.findNext(query, opts);
    $("#search-input").classList.toggle("none", !found);
}

// ---------- Sélecteurs des voyants (contexte / namespace K8s, dépôt Git) ----------

let pickerAnchor = null;

function openPicker(anchor, request, loadingText) {
    pickerAnchor = anchor;
    $("#picker").classList.remove("certs-panel");
    const panel = $("#picker");
    panel.replaceChildren(Object.assign(document.createElement("p"), { className: "picker-note", textContent: loadingText }));
    panel.hidden = false;
    placePicker();
    send({ t: request });
}

function placePicker() {
    const panel = $("#picker");
    const anchor = pickerAnchor?.isConnected ? pickerAnchor : document.querySelector(`[data-status="${pickerAnchor?.dataset.status}"]`);
    if (!anchor) {
        // ouvert depuis la palette (touche absente de la page) : en haut, au centre
        panel.style.top = "120px";
        panel.style.left = `${Math.max(8, (window.innerWidth - (panel.offsetWidth || 320)) / 2)}px`;
        return;
    }
    const box = anchor.getBoundingClientRect();
    const width = panel.offsetWidth || 320;
    panel.style.top = `${box.bottom + 8}px`;
    panel.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - width - 8))}px`;
}

function closePicker() {
    $("#picker").hidden = true;
    $("#picker").classList.remove("certs-panel");
    pickerAnchor = null;
}

function pickerSection(title, items, empty) {
    const section = Object.assign(document.createElement("section"), { className: "picker-section" });
    section.append(Object.assign(document.createElement("h3"), { textContent: title }));
    if (!items.length) section.append(Object.assign(document.createElement("p"), { className: "picker-note", textContent: empty }));
    const list = Object.assign(document.createElement("div"), { className: "picker-list" });
    for (const item of items) {
        const row = Object.assign(document.createElement("div"), { className: `picker-row${item.current ? " current" : ""}${item.prod ? " prod" : ""}` });
        const main = Object.assign(document.createElement("button"), { className: "picker-item", textContent: item.label, title: item.title ?? item.label });
        // Production : premier clic = avertissement, deuxième clic (dans les 5 s) = changement
        main.addEventListener("click", () => {
            if (!item.prod || item.current || row.classList.contains("armed")) return item.onClick();
            list.querySelectorAll(".picker-row.armed").forEach((r) => { r.classList.remove("armed"); r.querySelector(".picker-item").textContent = r.dataset.label; });
            row.dataset.label = item.label;
            row.classList.add("armed");
            main.textContent = `⚠ PRODUCTION : ${item.label}, clique encore pour confirmer`;
            setTimeout(() => { if (row.isConnected && row.classList.contains("armed")) { row.classList.remove("armed"); main.textContent = item.label; } }, 5000);
        });
        row.append(main);
        for (const action of item.actions ?? []) {
            const btn = Object.assign(document.createElement("button"), { className: "picker-action", textContent: action.label, title: action.title });
            btn.addEventListener("click", action.onClick);
            row.append(btn);
        }
        list.append(row);
    }
    section.append(list);
    return section;
}

function showKubePicker(msg) {
    if ($("#picker").hidden) return;
    const panel = $("#picker");
    const contexts = msg.contexts.map((c) => ({
        label: c.name, current: c.name === msg.current, prod: c.prod,
        onClick: () => { if (c.name !== msg.current) send({ t: "kube-use", context: c.name }); else closePicker(); }
    }));
    const namespaces = msg.namespaces.map((n) => ({
        label: n.name, current: n.name === msg.namespace, prod: n.prod,
        onClick: () => { if (n.name !== msg.namespace) send({ t: "kube-use", namespace: n.name }); else closePicker(); }
    }));
    panel.replaceChildren(
        pickerSection("Contexte", contexts, "aucun contexte dans kubeconfig"),
        pickerSection(`Namespace (${msg.current || "aucun contexte"})`, namespaces, msg.nsError ? `liste indisponible : ${msg.nsError}` : "aucun namespace")
    );
    placePicker();
}

/** Clic sur le voyant des certificats : tous les certificats de la mission, puis vérification immédiate. */
function openCertsPanel(anchor) {
    pickerAnchor = anchor;
    $("#picker").hidden = false;
    renderCertsPanel(true);
    send({ t: "press", id: "certs" });
}

function renderCertsPanel(checking = false) {
    if ($("#picker").hidden || pickerAnchor?.dataset.status !== "certs") return;
    const s = state.status.certs ?? { items: [] };
    const items = (s.items ?? []).map((c) => {
        const dot = c.error ? "⚪" : c.days < 7 ? "🔴" : c.days < 30 ? "🟠" : "🟢";
        const when = c.error ? `injoignable, ${c.error}`
            : `${c.days < 0 ? `expiré depuis ${-c.days} j` : `${c.days} j`} · ${new Date(c.until).toLocaleDateString("fr-FR")}${c.trusted ? "" : " · chaîne non reconnue"}`;
        return { label: `${dot} ${c.target} : ${when}`, title: c.reason ? `${c.target} : ${c.reason}` : c.target, onClick: () => {}, prod: !c.error && c.days < 7 };
    });
    const section = pickerSection("Certificats de la mission", items, "aucun certificat : Réglages › Missions › Modifier › Certificats à surveiller");
    const foot = Object.assign(document.createElement("p"), { className: "picker-note",
        textContent: checking ? "vérification en cours…" : `vérifié à ${new Date(s.checked ?? Date.now()).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })} · ensuite toutes les 30 min` });
    const again = Object.assign(document.createElement("button"), { type: "button", className: "picker-action", textContent: "Vérifier maintenant" });
    again.addEventListener("click", () => { renderCertsPanel(true); send({ t: "press", id: "certs" }); });
    foot.append(" ", again);
    $("#picker").classList.add("certs-panel");
    $("#picker").replaceChildren(section, foot);
    placePicker();
}

function showGitPicker(msg) {
    if ($("#picker").hidden) return;
    const repos = msg.repos.map((r) => ({
        label: r.name, title: r.path, current: r.path === msg.current,
        onClick: () => { send({ t: "git-select", repo: r.path }); closePicker(); },
        actions: [{ label: ">_", title: `Nouveau terminal dans ${r.path}`, onClick: () => { closePicker(); openTerm(r.path); } }]
    }));
    $("#picker").replaceChildren(pickerSection("Dépôts (clic : afficher · >_ : terminal dedans)", repos, "aucun dépôt dans gitRoots (paths.json)"));
    placePicker();
}

// ---------- Palette de commandes (Cmd/Ctrl+K) ----------

let paletteItems = [];
let paletteIndex = 0;

/**
 * Entrées de la palette : touches de toutes les rubriques (sans doublons), missions, et, coffre déverrouillé,
 * notes (titre et contenu) et secrets (nom, utilisateur, adresse ; jamais la valeur). Une entrée peut porter
 * sa propre action (run) au lieu d'une touche.
 */
function paletteEntries() {
    const seen = new Set();
    const entries = [];
    const v = state.vault;
    if (v.unlocked) {
        for (const n of v.notes ?? []) {
            const title = n.title || "Sans titre";
            const first = n.body.split("\n").map((l) => l.trim()).find(Boolean) ?? "note vide";
            entries.push({ key: { label: title, icon: "lucide-notebook-text", color: n.color || "#5c6bc0" }, where: "Note", detail: first.slice(0, 120), hay: `note ${title} ${n.body}`.toLowerCase(), run: () => { vaultUi.tab = "notes"; openVault(); selectNote(n.id); } });
        }
        for (const s of v.secrets ?? []) {
            entries.push({ key: { label: s.name, icon: "lucide-key-round", color: "#8e24aa" }, where: "Secret", detail: ["copier (effacé après 30 s)", s.user, s.url].filter(Boolean).join(" · "), hay: `secret ${s.name} ${s.user ?? ""} ${s.url ?? ""}`.toLowerCase(), run: () => copySecret(s.id) });
        }
    }
    for (const r of recentCommands) {
        const when = new Date(r.time).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
        entries.push({ key: { label: r.command, icon: "lucide-history", color: "#546e7a" }, where: `Récent · ${when}`, detail: `${r.label}${r.kube ? ` · ${r.kube}` : ""} · tapée sans Entrée`, hay: `recent récent ${r.label} ${r.command}`.toLowerCase(), run: () => typeInTerminal(r.command) });
    }
    for (const m of state.settings?.missions ?? []) {
        const active = m.id === state.settings.activeMission;
        entries.push({ key: { label: m.name, icon: "lucide-briefcase", color: m.color || "#00897b" }, where: "Mission", detail: active ? "mission active : Entrée pour la désactiver" : "activer cette mission", hay: `mission ${m.name}`.toLowerCase(), run: () => send({ t: "mission-activate", id: active ? "" : m.id }) });
    }
    entries.push({ key: { type: "vault", label: "Coffre : notes et secrets", icon: "lock", color: "#5c6bc0" }, where: "Coffre", detail: "notes et secrets chiffrés", hay: "coffre vault notes secrets mots de passe tokens password" });
    for (const [page, keys] of Object.entries(state.pages)) {
        for (const key of keys) {
            if (!key || ["status", "back", "clear", "fav-edit"].includes(key.type)) continue;
            const detail = key.type === "text" ? commandFor(key) : key.type === "web" ? key.url : key.type === "folder" ? "rubrique"
                : key.type === "fav-add" ? "nouveau favori" : "programme";
            if (detail == null) continue;
            const id = `${key.type}|${key.label}|${detail}`;
            if (seen.has(id)) continue;
            seen.add(id);
            const where = page === "root" ? "Accueil" : state.titles[page] ?? page;
            entries.push({ key, where, detail, hay: `${key.label} ${where} ${detail}`.toLowerCase() });
        }
    }
    return entries;
}

// Commandes récentes (journal du serveur) : proposées dans la palette, toujours tapées sans Entrée
let recentCommands = [];

function applyRecent(entries) {
    const seen = new Set();
    recentCommands = [];
    for (const e of entries) {
        const cmd = String(e.command ?? "").trim();
        // liens, commandes incomplètes (vides, à compléter, paramètres non remplis) : ignorés
        if (!cmd || e.mode === "lien" || /\{[^}]*\}/.test(cmd) || /\s$/.test(e.command) || seen.has(cmd)) continue;
        seen.add(cmd);
        recentCommands.push({ label: e.label, command: cmd, time: e.time, kube: e.kube });
        if (recentCommands.length >= 40) break;
    }
    if (!$("#palette").hidden) filterPalette();
}

function openPalette() {
    send({ t: "journal-recent" });
    $("#palette").hidden = false;
    const input = $("#palette-input");
    input.value = "";
    filterPalette();
    input.focus();
}

function closePalette() {
    $("#palette").hidden = true;
    state.terms.get(state.active)?.term.focus();
}

/** Recherche sans casse ni accents (« demo » trouve « Démo »). */
const fold = (s) => String(s).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

function filterPalette() {
    const words = fold($("#palette-input").value).split(/\s+/).filter(Boolean);
    paletteItems = paletteEntries().filter((e) => { const hay = fold(e.hay); return words.every((w) => hay.includes(w)); }).slice(0, 60);
    paletteIndex = 0;
    renderPalette();
}

function renderPalette() {
    const list = $("#palette-list");
    list.replaceChildren(...paletteItems.map((e, i) => {
        const row = Object.assign(document.createElement("li"), { className: `palette-row${i === paletteIndex ? " sel" : ""}` });
        row.style.setProperty("--c", e.key.color);
        const icon = Object.assign(document.createElement("span"), { className: "palette-icon" });
        if (e.key.icon) icon.style.setProperty("--logo", `url("/icons/${e.key.icon}.svg")`);
        const text = Object.assign(document.createElement("span"), { className: "palette-text" });
        text.append(
            Object.assign(document.createElement("span"), { className: "palette-label", textContent: e.key.label }),
            Object.assign(document.createElement("span"), { className: "palette-detail", textContent: e.detail })
        );
        const where = Object.assign(document.createElement("span"), { className: "palette-where", textContent: e.where });
        const badge = e.key.badge ? Object.assign(document.createElement("span"), { className: `dot ${e.key.badge}` }) : "";
        row.append(icon, text, where, badge);
        row.addEventListener("mousemove", () => { if (paletteIndex !== i) { paletteIndex = i; renderPalette(); } });
        row.addEventListener("click", () => runPalette(i));
        return row;
    }));
    if (!paletteItems.length) list.append(Object.assign(document.createElement("li"), { className: "palette-empty", textContent: state.vault.unlocked ? "rien ne correspond" : "rien ne correspond (notes et secrets : déverrouille le coffre)" }));
    list.children[paletteIndex]?.scrollIntoView({ block: "nearest" });
}

function runPalette(i) {
    const entry = paletteItems[i];
    if (!entry) return;
    $("#palette").hidden = true;
    if (entry.run) {
        state.terms.get(state.active)?.term.focus();
        return entry.run();
    }
    press(entry.key, document.querySelector(`[data-id="${CSS.escape(entry.key.id)}"]`));
}

// ---------- Favoris : glisser-déposer des touches ----------

const FAV_DRAG = "text/x-deck-fav";
let favDragged = null;   // touche du favori en cours de déplacement

/** Groupe parent de la page affichée, vu depuis un de ses groupes (null = racine des favoris). */
const parentGroupOf = (page) => {
    const parent = state.parents[page];
    return parent && parent.startsWith("fav-") ? parent.slice(4) : null;
};

/** Zone de dépôt sur une touche : avant / après (bords), ou dans le groupe (centre d'un groupe). */
function dropZone(ev, el, key) {
    const box = el.getBoundingClientRect();
    const x = (ev.clientX - box.left) / box.width;
    if (key.favGroup && x > 0.25 && x < 0.75) return "into";
    return x < 0.5 ? "before" : "after";
}

function clearFavMarks() {
    document.querySelectorAll(".key.fav-before, .key.fav-after, .key.fav-into, .key.fav-dragging")
        .forEach((el) => el.classList.remove("fav-before", "fav-after", "fav-into", "fav-dragging"));
}

function favDraggable(el, key) {
    el.draggable = true;
    el.addEventListener("dragstart", (ev) => {
        favDragged = key;
        ev.dataTransfer.setData(FAV_DRAG, key.fav);
        ev.dataTransfer.effectAllowed = "move";
        el.classList.add("fav-dragging");
    });
    el.addEventListener("dragend", () => {
        favDragged = null;
        clearFavMarks();
    });
    el.addEventListener("dragover", (ev) => {
        if (!favDragged || favDragged.fav === key.fav) return;
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "move";
        const zone = dropZone(ev, el, key);
        el.classList.toggle("fav-before", zone === "before");
        el.classList.toggle("fav-after", zone === "after");
        el.classList.toggle("fav-into", zone === "into");
    });
    el.addEventListener("dragleave", () => el.classList.remove("fav-before", "fav-after", "fav-into"));
    el.addEventListener("drop", (ev) => {
        ev.preventDefault();
        const moved = favDragged;
        const zone = dropZone(ev, el, key);
        clearFavMarks();
        if (!moved || moved.fav === key.fav) return;
        const here = currentFavGroup();
        if (zone === "into") return send({ t: "fav-place", id: moved.fav, parent: key.fav, before: null });
        // Avant / après dans la page affichée : "after" = avant l'élément suivant (ou à la fin)
        const order = state.pages[state.page].filter((k) => k?.fav).map((k) => k.fav);
        const next = order[order.indexOf(key.fav) + 1];
        const before = zone === "before" ? key.fav : next === moved.fav ? order[order.indexOf(key.fav) + 2] ?? null : next ?? null;
        send({ t: "fav-place", id: moved.fav, parent: here, before });
    });
}

/** Retour dans un groupe : y déposer un favori le fait remonter d'un niveau. */
function favDropOnBack(el) {
    el.addEventListener("dragover", (ev) => {
        if (!favDragged) return;
        ev.preventDefault();
        el.classList.add("fav-into");
    });
    el.addEventListener("dragleave", () => el.classList.remove("fav-into"));
    el.addEventListener("drop", (ev) => {
        ev.preventDefault();
        const moved = favDragged;
        clearFavMarks();
        if (moved) send({ t: "fav-place", id: moved.fav, parent: parentGroupOf(state.page), before: null });
    });
}

// ---------- Favoris : formulaire d'ajout / de modification ----------

let favEditing = null;   // touche du favori modifié, null pour un ajout
let favMoving = false;
let favRemoveArmed = false;   // suppression d'un groupe non vide : deuxième clic pour confirmer

/** Groupe de la page affichée (null = racine des favoris). */
const currentFavGroup = () => (state.page.startsWith("fav-") ? state.page.slice(4) : null);
const MAX_GROUP_DEPTH = 2;

/**
 * Formulaire d'un favori : ajout (key null, parent = groupe de la page) ou modification (site ou groupe).
 * Un groupe n'a pas d'adresse ; « Dans » permet de le ranger ailleurs (sans dépasser deux niveaux).
 */
function openFavForm(key = null) {
    favEditing = key;
    favRemoveArmed = false;
    const isGroup = key ? Boolean(key.favGroup) : false;
    const parent = currentFavGroup();   // ajout : dans le groupe affiché ; modification : là où l'élément se trouve
    $("#favform").querySelector("h2").textContent = key ? (isGroup ? "Modifier le groupe" : "Modifier le favori") : "Ajouter aux favoris";
    $("#fav-kind").hidden = Boolean(key);
    $("#fav-kind-site").checked = !isGroup;
    $("#fav-kind-group").checked = isGroup;
    // Dans un sous-groupe, on ne peut ajouter que des sites
    const canGroup = favDepth(state.page) < MAX_GROUP_DEPTH;
    $("#fav-kind-group").disabled = !canGroup;
    $("#fav-kind-group").parentElement.title = canGroup ? "" : "un sous-groupe ne contient que des sites";
    $("#fav-label").value = key?.label ?? "";
    $("#fav-url").value = key?.url ?? "";
    $("#fav-icon").value = key?.favIcon ?? "";   // vide = icône automatique
    fillParents(key, parent);
    favColor = key?.favColor ?? "";
    renderSwatches();
    for (const id of ["#fav-remove", "#fav-left", "#fav-right"]) $(id).hidden = !key;
    $("#fav-remove").textContent = "Supprimer";
    syncFavKind();
    $("#favdialog").hidden = false;
    $(key || isGroup ? "#fav-label" : "#fav-url").focus();
}

/** Choix « Dans » : racine des favoris et groupes où l'élément peut aller. */
function fillParents(key, parent) {
    const select = $("#fav-parent");
    const isGroup = key ? Boolean(key.favGroup) : $("#fav-kind-group").checked;
    // Hauteur d'un groupe modifié : 2 s'il contient des sous-groupes (il doit alors rester à la racine)
    const height = !isGroup ? 0 : key && hasSubgroups(key) ? 2 : 1;
    const options = [new Option("Favoris (racine)", "")];
    for (const g of state.favGroups) {
        if (key && (g.id === key.fav || isInside(g.id, key.fav))) continue;   // pas dans lui-même
        if (g.depth + height > MAX_GROUP_DEPTH) continue;
        options.push(new Option(`${"\u00a0\u00a0".repeat(g.depth - 1)}${g.path}`, g.id));
    }
    select.replaceChildren(...options);
    select.value = options.some((o) => o.value === (parent ?? "")) ? parent ?? "" : "";
}

/** Profondeur d'une page des favoris : 0 pour la rubrique, 1 pour un groupe, 2 pour un sous-groupe. */
function favDepth(page) {
    let depth = 0;
    for (let p = page; p && p !== "favoris" && p.startsWith("fav-"); p = state.parents[p]) depth++;
    return depth;
}

/** Le groupe groupId est-il (à n'importe quel niveau) à l'intérieur du groupe ancestorId ? */
function isInside(groupId, ancestorId) {
    for (let p = state.parents[`fav-${groupId}`]; p && p !== "favoris"; p = state.parents[p]) {
        if (p === `fav-${ancestorId}`) return true;
    }
    return false;
}

const hasSubgroups = (key) => (state.pages[`fav-${key.fav}`] ?? []).some((k) => k?.favGroup);

// ---------- Couleur d'un groupe : palette, ou n'importe quelle couleur (sélecteur du système) ----------

const GROUP_COLORS = [
    ["", "Par défaut (vert favoris)"], ["#1e88e5", "Bleu"], ["#00897b", "Turquoise"], ["#43a047", "Vert"], ["#fbc02d", "Jaune"],
    ["#fb8c00", "Orange"], ["#e53935", "Rouge"], ["#d81b60", "Rose"], ["#8e24aa", "Violet"], ["#546e7a", "Gris bleu"]
];
let favColor = "";

function renderSwatches() {
    const box = $("#fav-swatches");
    const custom = favColor && !GROUP_COLORS.some(([c]) => c === favColor);
    const buttons = GROUP_COLORS.map(([color, name]) => {
        const b = Object.assign(document.createElement("button"), { type: "button", className: `swatch${color === favColor ? " on" : ""}${color ? "" : " default"}`, title: name });
        b.style.setProperty("--sw", color || "#9ccc65");
        b.setAttribute("aria-pressed", String(color === favColor));
        b.addEventListener("click", () => { favColor = color; renderSwatches(); });
        return b;
    });
    // Couleur libre : sélecteur du système (input type=color)
    const picker = Object.assign(document.createElement("label"), { className: `swatch picker${custom ? " on" : ""}`, title: "Autre couleur…" });
    picker.style.setProperty("--sw", custom ? favColor : "transparent");
    const input = Object.assign(document.createElement("input"), { type: "color", value: custom ? favColor : "#1e88e5" });
    input.addEventListener("input", () => { favColor = input.value.toLowerCase(); renderSwatches(); });
    picker.append(input);
    box.replaceChildren(...buttons, picker);
}

// ---------- Couleur d'une note du coffre (même palette, plus « aucune ») ----------

const NOTE_COLORS = [["", "Aucune couleur"], ...GROUP_COLORS.slice(1)];

function renderNoteColors() {
    const box = $("#note-colors");
    const current = vaultUi.noteColor ?? "";
    const disabled = !vaultUi.noteId;
    const custom = current && !NOTE_COLORS.some(([c]) => c === current);
    const buttons = NOTE_COLORS.map(([color, name]) => {
        const b = Object.assign(document.createElement("button"), { type: "button", className: `swatch${color === current ? " on" : ""}${color ? "" : " none"}`, title: name, disabled });
        b.style.setProperty("--sw", color || "transparent");
        b.setAttribute("aria-pressed", String(color === current));
        b.addEventListener("click", () => setNoteColor(color));
        return b;
    });
    const picker = Object.assign(document.createElement("label"), { className: `swatch picker${custom ? " on" : ""}`, title: "Autre couleur…" });
    picker.style.setProperty("--sw", custom ? current : "transparent");
    const input = Object.assign(document.createElement("input"), { type: "color", value: custom ? current : "#1e88e5", disabled });
    input.addEventListener("input", () => setNoteColor(input.value.toLowerCase()));
    picker.append(input);
    box.replaceChildren(...buttons, picker);
    $(".vault-editor").style.setProperty("--note-c", current || "transparent");
}

/** Couleur choisie : affichée tout de suite, enregistrée aussitôt (pas d'attente de frappe). */
function setNoteColor(color) {
    if (!vaultUi.noteId) return;
    vaultUi.noteColor = color;
    const note = state.vault.notes?.find((n) => n.id === vaultUi.noteId);
    if (note) note.color = color || null;
    renderNoteColors();
    renderNotes();
    scheduleNote();
    flushNote();
}

/** Site : adresse visible ; groupe : pas d'adresse, mais une couleur. */
function syncFavKind() {
    const group = favEditing ? Boolean(favEditing.favGroup) : $("#fav-kind-group").checked;
    $("#fav-color-row").hidden = !group;
    $("#fav-url-row").hidden = group;
    $("#fav-url").required = !group;
    $("#fav-label").placeholder = group ? "Mission X, Monitoring, Docs…" : "nom de domaine si vide";
    $("#fav-icon").placeholder = group ? "dossier" : "automatique";
    if (!favEditing) fillParents(null, $("#fav-parent").value || currentFavGroup());
}

function closeFavForm() {
    $("#favdialog").hidden = true;
    favEditing = null;
}

function submitFav(ev) {
    ev.preventDefault();
    const group = favEditing ? Boolean(favEditing.favGroup) : $("#fav-kind-group").checked;
    const def = { kind: group ? "group" : "site", label: $("#fav-label").value, url: group ? "" : $("#fav-url").value, icon: $("#fav-icon").value, parent: $("#fav-parent").value || null, ...(group ? { color: favColor } : {}) };
    if (!def.label.trim() && def.url.trim()) {
        // Nom par défaut : le nom de domaine
        try { def.label = new URL(/^[a-z]+:\/\//i.test(def.url) ? def.url : `https://${def.url}`).hostname.replace(/^www\./, ""); } catch { /* le serveur signalera l'adresse invalide */ }
    }
    send(favEditing ? { t: "fav-update", id: favEditing.fav, ...def } : { t: "fav-add", ...def });
}

// ---------- Coffre : notes et secrets chiffrés (côté serveur, voir server/vault.mjs) ----------

const vaultUi = { tab: "notes", noteId: null, noteColor: "", secretEditing: null, shown: new Map(), preview: false };
let noteReq = null;
let noteTimer = null;

function openVault() {
    $("#vault").hidden = false;
    renderVault();
    (state.vault.unlocked ? (vaultUi.tab === "notes" ? $("#note-body") : $("#secret-search")) : $("#vault-pass")).focus();
}

// Sélection faite dans une note (éditeur ou aperçu) au moment de fermer le coffre : reprise par la prochaine
// touche « à compléter » si le terminal n'a pas de sélection. Oubliée après 10 min ou au verrouillage du coffre.
const NOTE_SELECTION_MS = 10 * 60 * 1000;
let noteSelection = null;

function captureNoteSelection() {
    if (!state.vault.unlocked || vaultUi.tab !== "notes") return;
    let text = "";
    const body = $("#note-body");
    if (!body.hidden && body.selectionEnd > body.selectionStart) text = body.value.slice(body.selectionStart, body.selectionEnd);
    else {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && $("#note-preview").contains(sel.anchorNode)) text = sel.toString();
    }
    text = text.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim().slice(0, 2000);
    if (!text) return;
    noteSelection = { text, time: Date.now() };
    toast(`sélection de la note gardée (« ${text.length > 40 ? `${text.slice(0, 40)}…` : text} ») : la prochaine touche à compléter l'insère`, "ok");
}

function closeVault() {
    captureNoteSelection();
    flushNote();
    $("#vault").hidden = true;
    state.terms.get(state.active)?.term.focus();
}

/** Nouvel état reçu du serveur : contenu mis à jour, ou tout effacé à l'écran si le coffre est verrouillé. */
function applyVault(view) {
    const wasUnlocked = state.vault.unlocked;
    state.vault = view;
    if (!view.unlocked) {
        noteSelection = null;   // rien d'une note ne reste en mémoire une fois le coffre verrouillé
        vaultUi.noteId = null;
        vaultUi.shown.clear();
        closeSecretForm();
        // Plus rien du contenu dans la page : listes, éditeur, champs de mot de passe
        $("#note-list").replaceChildren();
        $("#secret-list").replaceChildren();
        $("#note-search").value = "";
        $("#secret-search").value = "";
        $("#note-title").value = "";
        $("#note-body").value = "";
        $("#vault-pass").value = "";
        $("#vault-pass2").value = "";
    } else if (!wasUnlocked) {
        vaultUi.noteId = view.notes[0]?.id ?? null;
        loadNoteInEditor();
    }
    renderVault();
    refreshVaultIo();
}

function renderVault() {
    const v = state.vault;
    $("#vault-open").classList.toggle("on", Boolean(v.unlocked));
    $("#vault-locked").hidden = v.unlocked;
    $("#vault-lock").hidden = !v.unlocked;
    for (const tab of ["notes", "secrets"]) {
        $(`#vault-tab-${tab}`).classList.toggle("on", vaultUi.tab === tab);
        $(`#vault-tab-${tab}`).disabled = !v.unlocked;
        $(`#vault-${tab}`).hidden = !v.unlocked || vaultUi.tab !== tab;
    }
    $("#vault-info").textContent = v.unlocked ? `${v.notes.length} note(s) · ${v.secrets.length} secret(s) · verrouillage auto après ${v.idleLockMin} min` : "verrouillé";
    // Verrouillé : création du coffre (avec confirmation) ou déverrouillage
    const known = v.exists !== null;   // avant la connexion au serveur, on ne sait pas encore si le coffre existe
    $("#vault-pass2").hidden = !known || v.exists;
    $("#vault-locked-text").textContent = !known ? "Connexion au serveur…" : v.exists ? "Le coffre est verrouillé." : "Aucun coffre : choisis un mot de passe maître (8 caractères minimum) pour le créer.";
    $("#vault-unlock-btn").textContent = !known || v.exists ? "Déverrouiller" : "Créer le coffre";
    $("#vault-unlock-btn").disabled = !known;
    if (v.unlocked) {
        renderNotes();
        renderSecrets();
    }
}

// ----- Notes -----

function renderNotes() {
    if (!state.vault.unlocked) return;
    const q = $("#note-search").value.toLowerCase();
    const notes = state.vault.notes.filter((n) => !q || `${n.title} ${n.body}`.toLowerCase().includes(q));
    $("#note-list").replaceChildren(...notes.map((n) => {
        const li = Object.assign(document.createElement("li"), { className: `vault-item${n.id === vaultUi.noteId ? " on" : ""}${n.color ? " colored" : ""}` });
        if (n.color) li.style.setProperty("--nc", n.color);
        li.append(
            Object.assign(document.createElement("span"), { className: "vault-item-title", textContent: n.title }),
            Object.assign(document.createElement("span"), { className: "vault-item-sub", textContent: n.body.split("\n")[0].slice(0, 80) || "—" })
        );
        li.addEventListener("click", () => selectNote(n.id));
        return li;
    }));
    if (!notes.length) $("#note-list").append(Object.assign(document.createElement("li"), { className: "vault-empty", textContent: q ? "aucune note ne correspond" : "aucune note : « + Note »" }));
    const has = Boolean(vaultUi.noteId);
    for (const id of ["#note-title", "#note-body", "#note-delete", "#note-preview-toggle", "#note-to-terminal"]) $(id).disabled = !has;
    renderNoteColors();
}

function loadNoteInEditor() {
    const note = state.vault.notes?.find((n) => n.id === vaultUi.noteId);
    $("#note-title").value = note?.title ?? "";
    $("#note-body").value = note?.body ?? "";
    vaultUi.noteColor = note?.color ?? "";
    renderNoteColors();
    toggleNotePreview(Boolean(vaultUi.preview) && Boolean(note));   // l'aperçu reste ouvert d'une ouverture à l'autre
    $("#note-status").textContent = note ? `modifiée le ${new Date(note.updated).toLocaleString("fr-FR")}` : "";
    $("#note-delete").textContent = "Supprimer";
    delete $("#note-delete").dataset.armed;
}

function selectNote(id) {
    flushNote();
    vaultUi.noteId = id;
    loadNoteInEditor();
    renderNotes();
    $("#note-body").focus();
}

/** Enregistrement automatique 700 ms après la dernière frappe (et en quittant la note). */
function scheduleNote() {
    $("#note-status").textContent = "modification…";
    clearTimeout(noteTimer);
    noteTimer = setTimeout(flushNote, 700);
}

function flushNote() {
    if (!noteTimer) return;
    clearTimeout(noteTimer);
    noteTimer = null;
    if (!vaultUi.noteId || !state.vault.unlocked) return;
    noteReq = crypto.randomUUID();
    send({ t: "note-save", id: vaultUi.noteId, title: $("#note-title").value, body: $("#note-body").value, color: vaultUi.noteColor ?? "", req: noteReq });
}

// ---------- Notes en Markdown : aperçu, et affichage dans le terminal pour sélectionner puis lancer une action ----------

function toggleNotePreview(show = $("#note-preview").hidden) {
    const preview = $("#note-preview");
    vaultUi.preview = show;
    if (show) {
        preview.innerHTML = toHtml($("#note-body").value) || '<p class="hint">note vide</p>';   // HTML échappé par markdown.js
        decorateCodeBlocks(preview);
        renderRunbookBar();
    }
    preview.hidden = !show;
    $("#note-body").hidden = show;
    $("#note-preview-toggle").textContent = show ? "Modifier" : "Aperçu";
    $("#note-preview-toggle").classList.toggle("on", show);
}

/**
 * Blocs de code de l'aperçu : chaque ligne cliquable (tapée dans le terminal, sans Entrée ; marquée une fois utilisée,
 * pour suivre une procédure pas à pas) et bouton Copier par bloc.
 */
function decorateCodeBlocks(preview) {
    preview.querySelectorAll("pre").forEach((pre) => {
        const copy = Object.assign(document.createElement("button"), { type: "button", className: "md-copy", textContent: "Copier", title: "Copier tout le bloc" });
        copy.addEventListener("click", () => {
            navigator.clipboard.writeText(pre.querySelector("code").textContent).then(() => toast("bloc copié", "ok"), () => toast("copie refusée par le navigateur"));
        });
        pre.append(copy);
        pre.querySelectorAll(".md-code-line").forEach((line) => {
            const text = line.textContent.trim();
            if (!text) return;
            line.classList.add("clickable");
            line.classList.toggle("used", noteDone().includes(text));
            line.title = "Taper cette ligne dans le terminal (sans Entrée)";
            line.addEventListener("click", () => {
                if (window.getSelection()?.toString()) return;   // sélection en cours : on ne tape rien
                setNoteDone([...noteDone().filter((x) => x !== text), text]);
                line.classList.add("used");
                window.getSelection()?.removeAllRanges();
                closeVault();
                typeInTerminal(text);
                toast("ligne tapée dans le terminal : vérifie, puis Entrée (rouvre le coffre pour l'étape suivante)", "ok");
            });
        });
    });
}

/** Lignes déjà tapées de la note ouverte (avancement du runbook, gardé dans le coffre). */
const noteDone = () => state.vault.notes?.find((n) => n.id === vaultUi.noteId)?.done ?? [];

function setNoteDone(lines) {
    const note = state.vault.notes?.find((n) => n.id === vaultUi.noteId);
    if (!note) return;
    note.done = lines;   // affichage immédiat ; le serveur renvoie le coffre à jour
    send({ t: "note-done", id: note.id, done: lines });
    renderRunbookBar();
}

/** Barre de l'aperçu : « n étape(s) faite(s) sur m » et Recommencer (si au moins une ligne est faite). */
function renderRunbookBar() {
    const preview = $("#note-preview");
    preview.querySelector(".runbook-bar")?.remove();
    const lines = [...preview.querySelectorAll(".md-code-line.clickable")].map((l) => l.textContent.trim());
    const done = lines.filter((l) => noteDone().includes(l)).length;
    if (!done) return;
    const bar = Object.assign(document.createElement("div"), { className: "runbook-bar" });
    const reset = Object.assign(document.createElement("button"), { type: "button", className: "vault-btn", textContent: "Recommencer" });
    reset.addEventListener("click", () => {
        setNoteDone([]);
        preview.querySelectorAll(".md-code-line.used").forEach((l) => l.classList.remove("used"));
        renderRunbookBar();
    });
    bar.append(Object.assign(document.createElement("span"), { textContent: `✓ ${done} étape(s) faite(s) sur ${lines.length}` }), reset);
    preview.prepend(bar);
}

/**
 * Affiche la note dans le terminal actif : écrite dans l'affichage seulement (term.write), jamais envoyée au shell.
 * Le coffre se ferme pour laisser sélectionner une partie (une commande), puis cliquer une touche d'action.
 */
function noteToTerminal() {
    const t = state.terms.get(state.active);
    if (!t || t.ended) return toast("aucun terminal actif : ouvre un terminal (bouton +)");
    if (!vaultUi.noteId) return toast("choisis une note");
    flushNote();
    t.term.write(toAnsi($("#note-body").value, $("#note-title").value, t.term.cols) + "\r\n");
    t.term.scrollToBottom();
    closeVault();
    t.term.focus();
    toast(`note affichée dans « ${t.tab.querySelector(".tab-title")?.textContent ?? "le terminal"} » : sélectionne une partie, puis clique une touche (ou ⌥ + chiffre)`, "ok");
}

function newNote() {
    flushNote();
    vaultUi.noteId = null;
    noteReq = crypto.randomUUID();
    $("#note-title").value = "Nouvelle note";
    $("#note-body").value = "";
    send({ t: "note-save", title: "Nouvelle note", body: "", req: noteReq });
    setTimeout(() => { $("#note-title").select(); $("#note-title").focus(); }, 50);
}

// ----- Secrets -----

function renderSecrets() {
    if (!state.vault.unlocked) return;
    const q = $("#secret-search").value.toLowerCase();
    const secrets = state.vault.secrets.filter((s) => !q || `${s.name} ${s.user} ${s.url} ${s.note}`.toLowerCase().includes(q));
    const button = (text, title, onClick, cls = "") => {
        const b = Object.assign(document.createElement("button"), { type: "button", className: `vault-btn ${cls}`, textContent: text, title });
        b.addEventListener("click", onClick);
        return b;
    };
    $("#secret-list").replaceChildren(...secrets.map((s) => {
        const li = Object.assign(document.createElement("li"), { className: "secret-row" });
        const info = Object.assign(document.createElement("div"), { className: "secret-info" });
        const shown = vaultUi.shown.get(s.id);
        info.append(
            Object.assign(document.createElement("span"), { className: "vault-item-title", textContent: s.name }),
            Object.assign(document.createElement("span"), { className: "vault-item-sub", textContent: [s.user, s.url].filter(Boolean).join(" · ") || "—" }),
            Object.assign(document.createElement("code"), { className: `secret-mask${shown ? " shown" : ""}`, textContent: shown ?? "•".repeat(Math.min(s.length, 24)) })
        );
        li.append(info,
            button("Copier", "Copier dans le presse-papiers (effacé après 30 s)", () => copySecret(s.id)),
            button("Taper ▸", "Taper dans le terminal actif, sans Entrée (la valeur ne passe pas par la page)", () => {
                if (!state.active) return toast("aucun terminal actif");
                send({ t: "secret-type", id: s.id, sid: state.active });
            }),
            button(shown ? "Masquer" : "Afficher", "Afficher la valeur 15 s", () => {
                if (shown) { vaultUi.shown.delete(s.id); renderSecrets(); } else send({ t: "secret-reveal", id: s.id, purpose: "show" });
            }),
            button("Modifier", "Modifier", () => openSecretForm(s)));
        return li;
    }));
    if (!secrets.length) $("#secret-list").append(Object.assign(document.createElement("li"), { className: "vault-empty", textContent: q ? "aucun secret ne correspond" : "aucun secret : « + Secret »" }));
}

/** Valeur reçue (seulement sur demande) : copiée puis effacée du presse-papiers, ou affichée 15 s. */
/** Copie d'un secret : faite par le serveur dans le presse-papiers du système, effacée après 30 s. */
function copySecret(id) {
    send({ t: "secret-copy", id });
}

function useSecretValue({ id, value, purpose }) {
    if (purpose === "show") {
        vaultUi.shown.set(id, value);
        renderSecrets();
        setTimeout(() => { vaultUi.shown.delete(id); renderSecrets(); }, 15000);
    }
}

function openSecretForm(secret = null) {
    vaultUi.secretEditing = secret;
    $("#secret-form-title").textContent = secret ? "Modifier le secret" : "Nouveau secret";
    $("#secret-name").value = secret?.name ?? "";
    $("#secret-user").value = secret?.user ?? "";
    $("#secret-url").value = secret?.url ?? "";
    $("#secret-note").value = secret?.note ?? "";
    $("#secret-value").value = "";
    $("#secret-value").type = "password";
    $("#secret-value").placeholder = secret ? "laisser vide pour garder la valeur actuelle" : "token, mot de passe…";
    $("#secret-value").required = !secret;
    $("#secret-delete").hidden = !secret;
    $("#secret-delete").textContent = "Supprimer";
    delete $("#secret-delete").dataset.armed;
    $("#secret-form").hidden = false;
    $("#secret-name").focus();
}

function closeSecretForm() {
    $("#secret-form").hidden = true;
    $("#secret-value").value = "";
    vaultUi.secretEditing = null;
}

/** Mot de passe aléatoire de 24 caractères (sans caractères ambigus). */
function generatePassword() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789-_.!@#%+=";
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    return [...bytes].map((b) => chars[b % chars.length]).join("");
}

/** Bouton de suppression en deux clics (pas de fenêtre de confirmation du navigateur). */
function armOrRun(btn, text, run) {
    if (!btn.dataset.armed) {
        btn.dataset.armed = "1";
        btn.textContent = text;
        return;
    }
    run();
}

// ---------- Retour automatique à l'accueil (délai réglable dans Réglages) ----------

/** Rubrique ("monde") d'une page : les groupes de favoris font partie du monde Favoris. */
const worldOf = (page) => (page === "root" ? null : isFavPage(page) ? "favoris" : page);
const autoHome = { world: null, deadline: 0, total: 0, timer: null, last: 0 };

function armAutoHome() {
    const seconds = state.settings.autoHomeEnabled === false ? 0 : Number(state.settings.autoHomeSeconds) || 0;
    if (!seconds || state.page === "root") return cancelAutoHome();
    autoHome.world = worldOf(state.page);
    autoHome.total = seconds * 1000;
    autoHome.deadline = Date.now() + autoHome.total;
    autoHome.last = Date.now();
    $("#autohome").hidden = false;
    clearInterval(autoHome.timer);
    autoHome.timer = setInterval(tickAutoHome, 250);
    tickAutoHome();
}

function cancelAutoHome() {
    clearInterval(autoHome.timer);
    autoHome.timer = null;
    autoHome.world = null;
    $("#autohome").hidden = true;
}

/** En pause tant qu'on édite quelque chose (formulaires, coffre, palette, sélecteur, renommage, mode Modifier). */
function autoHomeBlocked() {
    return state.favEdit || ["#favdialog", "#vault", "#palette", "#picker", "#settings"].some((id) => !$(id).hidden)
        || document.activeElement?.classList.contains("tab-rename");
}

function tickAutoHome() {
    const now = Date.now();
    if (autoHomeBlocked()) autoHome.deadline += now - autoHome.last;   // le temps ne compte pas pendant la pause
    autoHome.last = now;
    const left = Math.max(0, autoHome.deadline - now);
    $("#autohome-bar").style.width = `${(left / autoHome.total) * 100}%`;
    $("#autohome").title = `retour à l'accueil dans ${Math.ceil(left / 1000)} s (Réglages pour changer le délai)`;
    $("#autohome").classList.toggle("paused", autoHomeBlocked());
    if (left > 0) return;
    cancelAutoHome();
    if (state.page !== "root") go("root");
}

// ---------- Réglages (espace admin) ----------

// ---------- Garde-fou production : touches qui agissent sur le cluster, contexte kubectl de prod ----------

let prodArmed = null;   // { id, timer } : touche armée, en attente du deuxième clic

/** « contexte / namespace » si le voyant kubectl est en production (prodPattern de config.jsonc), sinon null. */
function prodContext() {
    const k = state.status.kube;
    return k?.prod ? `${k.context} / ${k.namespace}` : null;
}

function armProdKey(key) {
    disarmProdKey(false);
    prodArmed = { id: key.id, timer: setTimeout(() => disarmProdKey(true), 5000) };
    toast(`PRODUCTION « ${prodContext()} » : clique à nouveau sur « ${key.label} » pour confirmer`);
    render();
}

function disarmProdKey(redraw) {
    if (!prodArmed) return;
    clearTimeout(prodArmed.timer);
    prodArmed = null;
    if (redraw) render();
}

// ---------- Rubriques Linux / macOS (Ansible) sur un poste Windows : actives via ssh / wsl ----------

const UNIX_HINT = "Demande Linux ou macOS : connecte le terminal actif en ssh (ou wsl)";

/** Touches "unix" utilisables : poste Linux / macOS, ou terminal actif connecté en ssh / wsl. */
const unixReady = () => state.localUnix || Boolean(state.remote[state.active]);

/** Outil vérifié sur ce poste : pas pour une touche "unix" d'un poste Windows (elle s'exécute à distance). */
const localTool = (key) => !(key.unix && !state.localUnix);

/** Re-dessine la page si elle contient des touches "unix" (changement de terminal ou de connexion). */
function refreshUnixKeys() {
    if (!state.localUnix && (state.pages[state.page] ?? []).some((k) => k?.unix)) render();
}

/** Badge « ssh » / « wsl » sur l'onglet des terminaux connectés. */
function markRemoteTabs() {
    for (const [sid, t] of state.terms) {
        const kind = state.remote[sid];
        t.tab.classList.toggle("remote", Boolean(kind));
        if (kind) t.tab.dataset.remote = kind;
        else delete t.tab.dataset.remote;
    }
}

// ---------- Outils non installés ----------

function applyTools(view) {
    state.tools = { missing: new Set(view.missing ?? []), install: view.install ?? {}, manager: view.manager ?? null };
    if (state.pages[state.page]) render();
}
// Retour sur l'onglet (après un brew install dans un autre terminal, par exemple) : nouvelle vérification
window.addEventListener("focus", () => send({ t: "tools-check" }));

// ---------- Serveur et sauvegardes (Réglages) ----------

function renderServer() {
    const s = state.server;
    $("#server-mode").textContent = !s ? ""
        : s.supervisor === "launchd" ? "Lancé en service macOS (LaunchAgent) : démarre avec la session et redémarre tout seul. Journal : ~/Library/Logs/web-deck-devsecops.log"
        : s.supervisor === "windows" ? "Lancé en service Windows (démarrage de session) : redémarre tout seul. Journal : %LOCALAPPDATA%\\web-deck-devsecops\\deck.log"
        : "Lancé à la main (start.command / start.cmd) : fermer sa fenêtre arrête le deck. Pour un lancement automatique et fiable : service/installer.command (Mac) ou service\\installer.cmd (Windows). Après un redémarrage d'ici, journal dans .deck.log.";
    const btn = $("#server-restart");
    btn.classList.remove("armed");
    btn.textContent = "Redémarrer le deck";
    const tok = $("#server-token");
    tok.classList.remove("armed");
    tok.disabled = false;
    tok.textContent = "Renouveler le jeton";
}

// ---------- Mise à jour en un clic (Réglages › Serveur) ----------

function applyUpdate(u) {
    state.update = u;
    const date = u.date ? new Date(u.date).toLocaleDateString("fr-FR") : "";
    const version = u.version ? `Version ${u.version}${date ? ` du ${date}` : ""}` : "Version inconnue";
    const status = u.error ? `vérification impossible : ${u.error}`
        : u.behind ? `${u.behind} nouveauté(s) disponible(s) sur GitHub`
        : u.checked ? "à jour" : "pas encore vérifiée";
    const dirty = u.dirty?.length ? ` · fichiers modifiés ici : ${u.dirty.join(", ")} (mise à jour bloquée)` : "";
    $("#update-state").textContent = `${version} · ${status}${dirty}`;
    $("#update-state").classList.toggle("update-available", Boolean(u.behind));
    const apply = $("#update-apply");
    apply.hidden = !u.behind || Boolean(u.dirty?.length);
    apply.classList.remove("armed");
    apply.disabled = false;
    apply.textContent = `Mettre à jour (${u.behind})`;
    $("#update-check").disabled = false;
    $("#update-check").textContent = "Vérifier";
    // Pastille sur l'engrenage : nouvelle version disponible
    $("#settings-open").classList.toggle("has-update", Boolean(u.behind));
}

/** Mettre à jour redémarre le deck : deuxième clic de confirmation. */
function applyUpdateNow() {
    const btn = $("#update-apply");
    if (!btn.classList.contains("armed")) {
        btn.classList.add("armed");
        btn.textContent = "Confirmer (redémarre le deck)";
        return;
    }
    btn.disabled = true;
    send({ t: "update-apply" });
}

/** Redémarrer arrête les commandes en cours : deuxième clic de confirmation. */
/** Renouveler le jeton : deuxième clic de confirmation (les autres navigateurs perdent l'accès). */
function renewToken() {
    const btn = $("#server-token");
    if (!btn.classList.contains("armed")) {
        btn.classList.add("armed");
        btn.textContent = "Confirmer (les autres navigateurs perdent l'accès)";
        return;
    }
    btn.disabled = true;
    send({ t: "token-renew" });
}

function restartServer() {
    const btn = $("#server-restart");
    if (!btn.classList.contains("armed")) {
        btn.classList.add("armed");
        btn.textContent = "Confirmer (les commandes en cours s'arrêtent)";
        return;
    }
    send({ t: "restart" });
}

/** Résultats du diagnostic : une ligne par vérification (OK, à surveiller, échec). */
function renderDiagnostic(checks) {
    const list = $("#diag-results");
    list.hidden = false;
    list.replaceChildren(...checks.map((c) => {
        const li = Object.assign(document.createElement("li"), { className: c.ok ? (c.warn ? "warn" : "ok") : "ko" });
        li.append(
            Object.assign(document.createElement("span"), { className: "diag-mark", textContent: c.ok ? (c.warn ? "!" : "✓") : "✗" }),
            Object.assign(document.createElement("strong"), { textContent: c.name }),
            Object.assign(document.createElement("span"), { className: "diag-detail", textContent: c.detail })
        );
        return li;
    }));
    const failed = checks.filter((c) => !c.ok).length;
    $("#server-diagnostic").disabled = false;
    $("#server-diagnostic").textContent = "Diagnostic";
    toast(failed ? `diagnostic : ${failed} problème(s), voir Réglages › Serveur` : "diagnostic : tout fonctionne", failed ? "ko" : "ok");
}

const BACKUP_LABELS = { "favoris.json": "Favoris", "actions.json": "Mes actions", "settings.json": "Réglages", "vault.enc": "Coffre (chiffré)" };

function renderBackups(all) {
    $("#backup-rows").replaceChildren(...Object.entries(BACKUP_LABELS).map(([name, label]) => {
        const list = all?.[name] ?? [];
        const row = Object.assign(document.createElement("div"), { className: "backup-row" });
        const select = document.createElement("select");
        if (!list.length) select.append(new Option("aucune copie pour l'instant", ""));
        for (const b of list) select.append(new Option(`${new Date(b.time).toLocaleString("fr-FR")} (${b.size < 1024 ? `${b.size} o` : `${Math.round(b.size / 1024)} Ko`})`, b.id));
        select.disabled = !list.length;
        const btn = Object.assign(document.createElement("button"), { type: "button", textContent: "Restaurer", disabled: !list.length });
        btn.addEventListener("click", () => {
            if (!btn.classList.contains("armed")) {
                btn.classList.add("armed");
                btn.textContent = "Confirmer";
                return;
            }
            send({ t: "backup-restore", name, id: select.value });
        });
        select.addEventListener("change", () => { btn.classList.remove("armed"); btn.textContent = "Restaurer"; });
        row.append(Object.assign(document.createElement("span"), { className: "backup-name", textContent: label }), select, btn);
        return row;
    }));
}

// ---------- Mes actions : rubriques et touches créées depuis les Réglages (actions.json, hors Git) ----------

let actionPending = false;          // envoi en cours : le formulaire reste ouvert jusqu'à la réponse
let actSectionEditing = null;       // rubrique modifiée (null = nouvelle)
let actEditing = null;              // { section, action } : action modifiée (action null = nouvelle)

function actButton(text, title, fn, cls = "") {
    const b = Object.assign(document.createElement("button"), { type: "button", textContent: text, title, className: cls });
    b.addEventListener("click", fn);
    return b;
}

/** Bouton de suppression : deuxième clic pour confirmer. */
function actDelete(fn) {
    const b = actButton("Supprimer", "Deux clics pour confirmer", () => {
        if (!b.classList.contains("armed")) { b.classList.add("armed"); b.textContent = "Confirmer"; return; }
        fn();
    });
    return b;
}

function renderActions() {
    const list = $("#act-list");
    const sections = state.actions ?? [];
    if (!sections.length) {
        list.replaceChildren(Object.assign(document.createElement("p"), { className: "hint", textContent: "aucune rubrique pour l'instant : « Nouvelle rubrique… », puis « + Action »" }));
        return;
    }
    list.replaceChildren(...sections.map((s) => {
        const box = Object.assign(document.createElement("div"), { className: "act-section" });
        box.style.setProperty("--c", s.color);
        const head = Object.assign(document.createElement("div"), { className: "act-head" });
        const icon = Object.assign(document.createElement("span"), { className: "world-icon" });
        icon.style.setProperty("--logo", `url("/icons/${s.icon}.svg")`);
        head.append(icon,
            Object.assign(document.createElement("strong"), { textContent: s.label }),
            Object.assign(document.createElement("span"), { className: "hint", textContent: `${s.actions.length} action(s)` }),
            Object.assign(document.createElement("span"), { className: "grow" }),
            actButton("+ Action", "Ajouter une touche dans cette rubrique", () => openActionForm(s), "primary"),
            actButton("Modifier", "Nom, icône, couleur", () => openSectionForm(s)),
            actButton("Exporter", "Fichier à partager : un collègue l'importe dans son deck", () => exportSection(s)),
            actDelete(() => send({ t: "action-section-delete", id: s.id })));
        const ul = Object.assign(document.createElement("ul"), { className: "act-actions" });
        ul.append(...s.actions.map((a, i) => {
            const li = document.createElement("li");
            const what = a.kind === "url" ? a.url : a.command;
            const textBox = Object.assign(document.createElement("span"), { className: "act-text" });
            textBox.append(
                Object.assign(document.createElement("strong"), { textContent: a.label + (a.pinned ? " · sur l'accueil" : "") }),
                Object.assign(document.createElement("code"), { textContent: what, title: a.description ?? what }));
            li.append(
                Object.assign(document.createElement("span"), { className: `dot ${a.kind === "url" ? "url" : a.enter ? "run" : "type"}`, title: a.kind === "url" ? "lien" : a.enter ? "exécutée" : "à compléter" }),
                textBox,
                Object.assign(document.createElement("span"), { className: "settings-actions" }));
            const up = actButton("↑", "Monter", () => send({ t: "action-move", section: s.id, id: a.id, delta: -1 }));
            const down = actButton("↓", "Descendre", () => send({ t: "action-move", section: s.id, id: a.id, delta: 1 }));
            up.disabled = i === 0;
            down.disabled = i === s.actions.length - 1;
            li.lastChild.append(up, down,
                actButton("Modifier", "", () => openActionForm(s, a)),
                actDelete(() => send({ t: "action-delete", section: s.id, id: a.id })));
            return li;
        }));
        box.append(head, ul);
        return box;
    }));
}

// ---------- Partage : rubrique de Mes actions, note du coffre ----------

const slugFile = (s) => fold(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "export";

function exportSection(s) {
    const section = { label: s.label, icon: s.icon, color: s.color, actions: s.actions.map(({ id, pinned, ...a }) => a) };
    downloadJson({ deck: "web-deck-devsecops", type: "rubrique", version: 1, section }, `rubrique-${slugFile(s.label)}.json`, "rubrique exportée");
}

let actImport = null;

/** Fichier de rubrique choisi : contenu montré (nom, commandes) avant l'import, qui se fait sur confirmation. */
async function readSectionFile(file) {
    if (!file) return;
    $("#act-import-file").value = "";
    let data;
    try {
        if (file.size > 200000) throw new Error("fichier trop gros");
        data = JSON.parse(await file.text());
        if (data?.type !== "rubrique" || !Array.isArray(data.section?.actions)) throw new Error("ce n'est pas une rubrique exportée depuis le deck");
    } catch (err) {
        return toast(`import impossible : ${err.message}`);
    }
    actImport = data.section;
    $("#act-import-title").textContent = `Rubrique « ${String(actImport.label ?? "").slice(0, 30)} » : ${actImport.actions.length} action(s)`;
    $("#act-import-list").replaceChildren(...actImport.actions.slice(0, 20).map((a) => {
        const li = document.createElement("li");
        const box = Object.assign(document.createElement("span"), { className: "act-text" });
        box.append(Object.assign(document.createElement("strong"), { textContent: String(a.label ?? "") }),
            Object.assign(document.createElement("code"), { textContent: String(a.kind === "url" ? a.url : a.command ?? "") }));
        li.append(Object.assign(document.createElement("span"), { className: `dot ${a.kind === "url" ? "url" : a.enter ? "run" : "type"}` }), box);
        return li;
    }));
    $("#act-import-error").hidden = true;
    $("#act-import-confirm").hidden = false;
}

function importSection() {
    if (!actImport) return;
    send({ t: "action-section-import", section: actImport });
    actionSending("#act-import-ok");
}

/** Mots qui ressemblent à un secret : l'export d'une note (en clair) demande alors une confirmation. */
const SECRET_HINT = /(-----BEGIN [A-Z ]*PRIVATE KEY|\b(password|passwd|mot de passe|mdp|secret|token|api[_-]?key)\s*[:=]\s*\S|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bglpat-[A-Za-z0-9_-]{20,}|\bxox[abpr]-[A-Za-z0-9-]{10,})/i;
let noteExportArmed = 0;

function exportNote() {
    const note = state.vault.notes?.find((n) => n.id === vaultUi.noteId);
    if (!note) return;
    flushNote();
    const body = $("#note-body").value;
    const title = $("#note-title").value.trim() || "note";
    if (SECRET_HINT.test(body) && Date.now() - noteExportArmed > 5000) {
        noteExportArmed = Date.now();
        return toast("cette note semble contenir un secret (mot de passe, token, clé) : le fichier sera en clair. Reclique sur Exporter dans les 5 s pour confirmer");
    }
    noteExportArmed = 0;
    const url = URL.createObjectURL(new Blob([body.endsWith("\n") ? body : `${body}\n`], { type: "text/markdown;charset=utf-8" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `${slugFile(title)}.md` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`note exportée en clair : ${slugFile(title)}.md (dans Téléchargements)`, "ok");
}

/** Notes Markdown reçues : une note chiffrée par fichier, titre = nom du fichier. */
async function importNotes(files) {
    $("#note-import-file").value = "";
    let done = 0;
    for (const file of files) {
        if (file.size > 200000) { toast(`${file.name} : trop gros (200 Ko au plus)`); continue; }
        const title = file.name.replace(/\.(md|markdown|txt)$/i, "").replace(/[-_]+/g, " ").trim().slice(0, 120) || "Note importée";
        send({ t: "note-save", title, body: await file.text(), req: `import-${crypto.randomUUID()}` });
        done++;
    }
    if (done) toast(`${done} note(s) importée(s) dans le coffre (chiffrées)`, "ok");
}

function openSectionForm(s = null) {
    actSectionEditing = s;
    $("#act-form").hidden = true;
    $("#act-section-title").textContent = s ? `Rubrique « ${s.label} »` : "Nouvelle rubrique";
    $("#act-section-label").value = s?.label ?? "";
    $("#act-section-icon").value = s?.icon ?? "";
    $("#act-section-color").value = s?.color ?? "#607d8b";
    showActionError("");
    $("#act-section-form").hidden = false;
    $("#act-section-label").focus();
}

function openActionForm(section, a = null) {
    actEditing = { section, action: a };
    $("#act-section-form").hidden = true;
    $("#act-title").textContent = a ? `Action « ${a.label} » (${section.label})` : `Nouvelle action dans « ${section.label} »`;
    for (const r of document.querySelectorAll('input[name="act-kind"]')) r.checked = r.value === (a?.kind ?? "command");
    $("#act-label").value = a?.label ?? "";
    $("#act-command").value = a?.command ?? "";
    $("#act-enter").checked = a?.enter ?? false;
    $("#act-pinned").checked = a?.pinned ?? false;
    $("#act-url").value = a?.url ?? "";
    $("#act-icon").value = a?.icon ?? "";
    $("#act-description").value = a?.description ?? "";
    syncActionKind();
    showActionError("");
    $("#act-form").hidden = false;
    $("#act-label").focus();
}

/** Commande : champ commande et case « exécuter » ; lien : champ adresse. */
function syncActionKind() {
    const url = document.querySelector('input[name="act-kind"]:checked')?.value === "url";
    $("#act-command-row").hidden = url;
    $("#act-enter-row").hidden = url;
    $("#act-url-row").hidden = !url;
}

function saveSection() {
    send({ t: "action-section-save", section: { ...(actSectionEditing ? { id: actSectionEditing.id } : {}), label: $("#act-section-label").value, icon: $("#act-section-icon").value, color: $("#act-section-color").value } });
    actionSending("#act-section-save");
}

function saveAction() {
    const kind = document.querySelector('input[name="act-kind"]:checked')?.value ?? "command";
    send({ t: "action-save", section: actEditing.section.id, action: {
        ...(actEditing.action ? { id: actEditing.action.id } : {}),
        kind, label: $("#act-label").value, command: $("#act-command").value, enter: $("#act-enter").checked, pinned: $("#act-pinned").checked,
        url: $("#act-url").value, icon: $("#act-icon").value, description: $("#act-description").value
    } });
    actionSending("#act-save");
}

function actionSending(button) {
    actionPending = true;
    $(button).disabled = true;
}

function actionDone() {
    actionPending = false;
    $("#act-section-save").disabled = false;
    $("#act-save").disabled = false;
    $("#act-import-ok").disabled = false;
}

/** Erreur affichée dans le formulaire ouvert (saisie gardée), champ concerné sélectionné. */
function showActionError(text) {
    if (actImport && !$("#act-import-confirm").hidden) {
        $("#act-import-error").textContent = text;
        $("#act-import-error").hidden = !text;
        return;
    }
    const sectionForm = !$("#act-section-form").hidden;
    for (const id of ["#act-error", "#act-section-error"]) { $(id).hidden = true; $(id).textContent = ""; }
    if (!text) return;
    const el = $(sectionForm ? "#act-section-error" : "#act-error");
    el.textContent = text;
    el.hidden = false;
    const field = /icône/i.test(text) ? (sectionForm ? "#act-section-icon" : "#act-icon")
        : /couleur/i.test(text) ? "#act-section-color"
        : /nom/i.test(text) ? (sectionForm ? "#act-section-label" : "#act-label")
        : /commande/i.test(text) ? "#act-command" : /adresse/i.test(text) ? "#act-url" : null;
    if (field) $(field).focus();
}

// ---------- Missions : profils par client (Réglages › Missions, sélecteur de l'en-tête) ----------

let missionEditing = null;   // mission modifiée (null = nouvelle)
let missionPending = false;  // enregistrement envoyé : le formulaire reste ouvert jusqu'à la réponse

const activeMission = () => (state.settings?.missions ?? []).find((m) => m.id === state.settings?.activeMission) ?? null;

/** Sélecteur de l'en-tête : affiché dès qu'une mission existe. */
function renderMissionSwitch() {
    const sel = $("#mission-switch");
    const missions = state.settings?.missions ?? [];
    sel.hidden = !missions.length;
    sel.replaceChildren(new Option("Mission : aucune", ""), ...missions.map((m) => new Option(`Mission : ${m.name}`, m.id)));
    sel.value = state.settings?.activeMission ?? "";
}

function renderMissions() {
    const missions = state.settings?.missions ?? [];
    const list = $("#mission-list");
    if (!missions.length) {
        list.replaceChildren(Object.assign(document.createElement("li"), { className: "hint", textContent: "aucune mission : « Nouvelle mission… » enregistre le thème et les rubriques actuels avec un nom" }));
        return;
    }
    list.replaceChildren(...missions.map((m) => {
        const li = document.createElement("li");
        const active = m.id === state.settings.activeMission;
        const details = [m.theme || "sans thème", `prod : ${m.prodPattern || state.prodPatternDefault}`, m.workspace || "dossier par défaut"].join(" · ");
        const button = (text, fn, cls = "") => {
            const b = Object.assign(document.createElement("button"), { type: "button", textContent: text, className: cls });
            b.addEventListener("click", fn);
            return b;
        };
        const del = button("Supprimer", () => {
            if (!del.classList.contains("armed")) { del.classList.add("armed"); del.textContent = "Confirmer"; return; }
            send({ t: "mission-delete", id: m.id });
        });
        li.append(
            Object.assign(document.createElement("strong"), { textContent: m.name + (active ? " (active)" : "") }),
            Object.assign(document.createElement("span"), { className: "hint", textContent: details }),
            Object.assign(document.createElement("span"), { className: "settings-actions" })
        );
        li.lastChild.append(
            active ? button("Désactiver", () => send({ t: "mission-activate", id: "" })) : button("Activer", () => send({ t: "mission-activate", id: m.id }), "primary"),
            button("Modifier", () => openMissionForm(m)),
            del
        );
        if (active) li.classList.add("active");
        return li;
    }));
}

function openMissionForm(m = null) {
    missionEditing = m;
    $("#mission-name").value = m?.name ?? "";
    $("#mission-theme").value = m?.theme ?? state.settings?.missionTheme ?? "";
    $("#mission-prod").value = m?.prodPattern ?? "";
    $("#mission-prod").placeholder = `vide = ${state.prodPatternDefault} (config.jsonc)`;
    $("#mission-workspace").value = m?.workspace ?? "";
    $("#mission-workspace").placeholder = `vide = ${state.workspace}`;
    const fav = $("#mission-fav");
    fav.replaceChildren(new Option("Aucun (page Favoris)", ""), ...(state.favGroups ?? []).map((g) => new Option(g.path, g.id)));
    fav.value = m?.favGroup ?? "";
    $("#mission-vars").value = Object.entries(m?.vars ?? {}).map(([k, v]) => `${k} = ${v}`).join("\n");
    $("#mission-certs").value = (m?.certs ?? []).join("\n");
    $("#mission-capture").checked = !m;
    showMissionError("");
    $("#mission-form").hidden = false;
    $("#mission-name").focus();
}

/** « nom = valeur » par ligne (lignes vides et # commentaires ignorées) ; erreur lisible sinon. */
function parseMissionVars(text) {
    const vars = {};
    for (const [i, raw] of text.split("\n").entries()) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const m = /^([A-Za-z][A-Za-z0-9_-]{0,30})\s*[=:]\s*(.*)$/.exec(line);
        if (!m) throw new Error(`variables, ligne ${i + 1} : écrire « nom = valeur » (nom : lettres, chiffres, - et _)`);
        vars[m[1]] = m[2].trim();
    }
    return vars;
}

function saveMission() {
    const name = $("#mission-name").value.trim();
    if (!name) return showMissionError("le nom est obligatoire");
    let vars;
    try { vars = parseMissionVars($("#mission-vars").value); } catch (err) { return showMissionError(err.message); }
    send({ t: "mission-save", mission: {
        ...(missionEditing ? { id: missionEditing.id } : {}),
        name,
        theme: $("#mission-theme").value,
        prodPattern: $("#mission-prod").value.trim(),
        workspace: $("#mission-workspace").value.trim(),
        favGroup: $("#mission-fav").value,
        vars,
        // « https://api.client.fr/chemin » accepté : seul l'hôte (et le port) est gardé
        certs: $("#mission-certs").value.split(/[\n,]/).map((l) => l.trim().replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "")).filter(Boolean),
        captureWorlds: $("#mission-capture").checked
    } });
    // Pas de fermeture ici : seulement quand le serveur confirme (une erreur garde la saisie)
    missionPending = true;
    $("#mission-save").disabled = true;
    $("#mission-save").textContent = "Enregistrement…";
}

function missionDone() {
    missionPending = false;
    $("#mission-save").disabled = false;
    $("#mission-save").textContent = "Enregistrer la mission";
}

/** Erreur dans le formulaire (saisie gardée), champ concerné sélectionné. */
function showMissionError(text) {
    const el = $("#mission-error");
    el.textContent = text;
    el.hidden = !text;
    if (!text) return;
    const field = /certificat|port invalide/i.test(text) ? "#mission-certs" : /variable/i.test(text) ? "#mission-vars" : /dossier/i.test(text) ? "#mission-workspace" : /motif/i.test(text) ? "#mission-prod" : /nom/i.test(text) ? "#mission-name" : null;
    if (field) { $(field).focus(); $(field).select(); }
}

/** Rubriques à cocher (Réglages) : toutes celles disponibles sur ce système, dans l'ordre de l'accueil. */
function renderWorldChoices() {
    const w = state.worlds;
    const list = $("#set-worlds");
    if (!w) { list.replaceChildren(); return; }
    list.replaceChildren(...w.list.map((world) => {
        const label = Object.assign(document.createElement("label"), { className: "world-choice", title: world.byDefault ? "rubrique de config.jsonc" : "rubrique du catalogue, absente de config.jsonc" });
        label.style.setProperty("--c", world.color);
        const box = Object.assign(document.createElement("input"), { type: "checkbox", checked: world.on });
        box.dataset.id = world.id;
        box.dataset.default = world.byDefault ? "1" : "";
        box.addEventListener("change", updateWorldCount);
        const icon = Object.assign(document.createElement("span"), { className: "world-icon" });
        if (world.icon) icon.style.setProperty("--logo", `url("/icons/${world.icon}.svg")`);
        label.append(box, icon, Object.assign(document.createElement("span"), { textContent: world.label }));
        worldDraggable(label, world.id);
        return label;
    }));
    updateWorldCount();
}

// Ordre des rubriques : glisser une case avant / après une autre (trait de couleur = emplacement)
let worldDragId = null;

function worldDraggable(label, id) {
    label.draggable = true;
    label.dataset.world = id;
    label.addEventListener("dragstart", (ev) => {
        worldDragId = id;
        ev.dataTransfer.effectAllowed = "move";
        ev.dataTransfer.setData("text/plain", id);
        label.classList.add("dragging");
    });
    label.addEventListener("dragend", () => {
        worldDragId = null;
        label.classList.remove("dragging");
        clearWorldDropMarks();
    });
    label.addEventListener("dragover", (ev) => {
        if (!worldDragId || worldDragId === id) return;
        ev.preventDefault();
        const r = label.getBoundingClientRect();
        const after = ev.clientX > r.left + r.width / 2;
        clearWorldDropMarks();
        label.classList.add(after ? "drop-after" : "drop-before");
    });
    label.addEventListener("dragleave", () => label.classList.remove("drop-before", "drop-after"));
    label.addEventListener("drop", (ev) => {
        ev.preventDefault();
        const moved = $("#set-worlds").querySelector(`[data-world="${worldDragId}"]`);
        if (!moved || moved === label) return;
        const after = label.classList.contains("drop-after");
        label[after ? "after" : "before"](moved);
        clearWorldDropMarks();
    });
}

function clearWorldDropMarks() {
    for (const el of $("#set-worlds").querySelectorAll(".drop-before, .drop-after")) el.classList.remove("drop-before", "drop-after");
}

/** Ordre affiché ; [] s'il est identique à celui de config.jsonc (rien de forcé). */
function worldOrderChoice() {
    const order = [...$("#set-worlds").querySelectorAll("[data-world]")].map((el) => el.dataset.world);
    return order.join() === (state.worlds?.defaultOrder ?? []).join() ? [] : order;
}

/** Ordre par défaut : celui de config.jsonc (les cases cochées restent cochées). */
function resetWorldOrder() {
    const list = $("#set-worlds");
    for (const id of state.worlds?.defaultOrder ?? []) {
        const el = list.querySelector(`[data-world="${id}"]`);
        if (el) list.append(el);
    }
}

/** Touches de l'accueil avec les rubriques cochées (limite du serveur : max). */
function updateWorldCount() {
    const w = state.worlds;
    if (!w) return;
    const checked = [...$("#set-worlds").querySelectorAll("input:checked")].length;
    const total = checked + w.shortcuts;
    const count = $("#set-worlds-count");
    count.textContent = `${total} / ${w.max} touches sur l'accueil (${checked} rubriques + ${w.shortcuts} raccourcis)`;
    count.classList.toggle("over", total > w.max);
}

/** Écarts avec config.jsonc seulement : une rubrique remise comme dans le fichier n'est plus forcée. */
function worldChoices() {
    return Object.fromEntries([...$("#set-worlds").querySelectorAll("input")]
        .filter((box) => box.checked !== Boolean(box.dataset.default))
        .map((box) => [box.dataset.id, box.checked]));
}

function openSettings() {
    $("#set-autohome").value = state.settings.autoHomeSeconds;
    $("#set-autohome-on").checked = state.settings.autoHomeEnabled !== false;
    toggleAutoHomeRow();
    $("#set-appearance").value = state.settings.appearance ?? "dark";
    $("#set-theme").value = state.settings.missionTheme ?? "";
    $("#set-watermark").value = state.settings.watermark ?? "";
    $("#set-watermark-style").value = state.settings.watermarkStyle ?? "text";
    $("#set-watermark-font").value = state.settings.watermarkFont ?? "ANSI Shadow";
    $("#set-watermark-font-row").hidden = $("#set-watermark-style").value !== "ascii";
    renderWorldChoices();
    renderMissions();
    $("#mission-form").hidden = true;
    renderActions();
    $("#act-section-form").hidden = true;
    $("#set-journal-on").checked = state.settings.journalEnabled !== false;
    $("#journal-clear").classList.remove("armed");
    $("#journal-clear").textContent = "Effacer";
    send({ t: "journal-list" });
    send({ t: "rec-list" });
    $("#act-form").hidden = true;
    renderServer();
    send({ t: "backup-list" });
    $("#settings").hidden = false;
    refreshVaultIo();
    // Pas de focus sur un champ : le premier clic doit agir directement (sinon il ne sert qu'à quitter ce champ)
    document.activeElement?.blur();
    $(".settings-box").scrollTop = 0;
}

// ---------- Configuration complète (Réglages) : favoris, Mes actions, réglages et missions, signature ----------

let pendingConfig = null;

async function readConfigFile(file) {
    if (!file) return;
    try {
        if (file.size > 900 * 1024) throw new Error("fichier trop gros (900 Ko au plus)");
        const data = JSON.parse(await file.text());
        if (data?.kind !== "configuration") throw new Error("ce n'est pas un export de configuration du deck");
        pendingConfig = data;
        const count = (items) => (items ?? []).reduce((n, f) => n + (f?.type === "group" ? count(f.items) : 1), 0);
        $("#config-import-summary").textContent = `${file.name}${data.from ? ` (depuis ${data.from.machine}, ${data.from.platform})` : ""} : ${count(data.favorites)} favori(s), ${(data.actions ?? []).length} rubrique(s) d'actions, ${(data.settings?.missions ?? []).length} mission(s)${data.signature ? ", signature" : ""}`;
        $("#cfg-part-signature").disabled = !data.signature;
        $("#cfg-part-signature").checked = Boolean(data.signature);
        $("#config-import-confirm").hidden = false;
    } catch (err) {
        toast(`import impossible : ${err.message.split("\n")[0]}`);
    } finally {
        $("#config-import-file").value = "";
    }
}

function importConfig() {
    if (!pendingConfig) return;
    send({ t: "config-import", data: pendingConfig, parts: {
        favorites: $("#cfg-part-favorites").checked, favoritesMode: $("#cfg-fav-mode").value,
        actions: $("#cfg-part-actions").checked, settings: $("#cfg-part-settings").checked, signature: $("#cfg-part-signature").checked
    } });
}

// ---------- Export / import des favoris (Réglages) ----------

let pendingImport = null;
let settingsPending = false;   // réglages envoyés, en attente de la confirmation du serveur

function downloadJson(data, filename, what = "favoris exportés") {
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: "application/json" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`${what} : ${filename} (dans Téléchargements)`, "ok");
}

/** Fichier choisi : lu et résumé dans la page, puis l'utilisateur choisit Fusionner ou Remplacer. */
async function readImportFile(file) {
    if (!file) return;
    try {
        if (file.size > 900 * 1024) throw new Error("fichier trop gros pour des favoris");
        const data = JSON.parse(await file.text());
        const list = Array.isArray(data) ? data : data?.kind === "favoris" && Array.isArray(data.favorites) ? data.favorites : null;
        if (!list) throw new Error("ce n'est pas un export de favoris du deck");
        const count = (items) => items.reduce((n, f) => n + (f?.type === "group" ? count(Array.isArray(f.items) ? f.items : []) : 1), 0);
        const groups = (items) => items.reduce((n, f) => n + (f?.type === "group" ? 1 + groups(Array.isArray(f.items) ? f.items : []) : 0), 0);
        pendingImport = data;
        $("#fav-import-summary").textContent = `${file.name} : ${count(list)} site(s), ${groups(list)} groupe(s)`;
        $("#fav-import-confirm").hidden = false;
        $("#fav-import-merge").focus();
    } catch (err) {
        toast(`import impossible : ${err.message.split("\n")[0]}`);
    } finally {
        $("#fav-import-file").value = "";
    }
}

function hideImportConfirm() {
    pendingImport = null;
    $("#fav-import-confirm").hidden = true;
    $("#fav-import-replace").classList.remove("armed");
    $("#fav-import-replace").textContent = "Remplacer tout";
}

/** Remplacer efface les favoris actuels : deuxième clic de confirmation. */
function importFavorites(mode) {
    if (!pendingImport) return;
    const btn = $("#fav-import-replace");
    if (mode === "replace" && !btn.classList.contains("armed")) {
        btn.classList.add("armed");
        btn.textContent = "Confirmer le remplacement";
        return;
    }
    send({ t: "fav-import", mode, data: pendingImport });
}

// ---------- Export / import du coffre (Réglages) : le fichier reste chiffré ----------

let pendingVault = null;

/** Boutons selon l'état du coffre : export et fusion seulement déverrouillé, "utiliser" seulement sans coffre. */
function refreshVaultIo() {
    const v = state.vault;
    $("#vault-export").disabled = !v.unlocked;
    $("#vault-export").title = v.unlocked ? "Télécharge le coffre, toujours chiffré" : "Déverrouille d'abord le coffre";
    $("#vault-io-state").textContent = v.exists === false ? "aucun coffre sur cette machine" : v.unlocked ? "" : "coffre verrouillé : déverrouille-le pour exporter ou fusionner";
    const open = Boolean(pendingVault);
    $("#vault-import-use").hidden = !open || v.exists !== false;
    $("#vault-import-merge").hidden = !open || !v.unlocked;
    $("#vault-import-replace").hidden = !open || !v.unlocked;
    $("#vault-import-open").hidden = !open || !v.exists || v.unlocked;
    $("#vault-import-pass").hidden = !open || (v.exists && !v.unlocked);
}

async function readVaultFile(file) {
    if (!file) return;
    try {
        if (file.size > 900 * 1024) throw new Error("fichier trop gros (900 Ko au plus)");
        const data = JSON.parse(await file.text());
        const box = data?.kind === "coffre" ? data.vault : data;
        if (box?.kdf !== "scrypt" || !box?.data) throw new Error("ce n'est pas un export du coffre du deck");
        pendingVault = data;
        const when = data.exported ? ` exporté le ${new Date(data.exported).toLocaleString("fr-FR")}` : "";
        $("#vault-import-summary").textContent = `${file.name}${when} (contenu chiffré)`;
        $("#vault-import-confirm").hidden = false;
        refreshVaultIo();
        if (!$("#vault-import-pass").hidden) $("#vault-import-pass").focus();
    } catch (err) {
        toast(`import impossible : ${err.message.split("\n")[0]}`);
    } finally {
        $("#vault-import-file").value = "";
    }
}

function hideVaultImport() {
    pendingVault = null;
    $("#vault-import-pass").value = "";
    $("#vault-import-confirm").hidden = true;
    $("#vault-import-replace").classList.remove("armed");
    $("#vault-import-replace").textContent = "Remplacer tout";
    refreshVaultIo();
}

function importVault(mode) {
    if (!pendingVault) return;
    const password = $("#vault-import-pass").value;
    if (!password) { toast("saisis le mot de passe maître du fichier importé"); $("#vault-import-pass").focus(); return; }
    const btn = $("#vault-import-replace");
    if (mode === "replace" && !btn.classList.contains("armed")) {
        btn.classList.add("armed");
        btn.textContent = "Confirmer le remplacement";
        return;
    }
    send({ t: "vault-import", mode, data: pendingVault, password });
    $("#vault-import-pass").value = "";
}

/** Délai affiché seulement si le retour automatique est activé (désactivé : le délai n'est pas exigé). */
function toggleAutoHomeRow() {
    const on = $("#set-autohome-on").checked;
    $("#set-autohome-row").hidden = !on;
    $("#set-autohome").disabled = !on;
}

/** Fermeture sans enregistrer : l'aperçu de l'apparence est annulé. */
function closeSettings() {
    $("#settings").hidden = true;
    applyWatermark();
    hideImportConfirm();
    hideVaultImport();
    applyAppearance(state.settings.appearance, state.settings.missionTheme);
}

/** Aperçu immédiat du mode et du thème choisis (enregistrés seulement avec « Enregistrer »). */
function previewAppearance() {
    applyAppearance($("#set-appearance").value, $("#set-theme").value);
}

// ---------- Enregistrement de sessions (● REC) ----------

/** Point rouge sur les onglets enregistrés, bouton REC allumé si le terminal actif l'est, bandeau. */
function applyRec() {
    for (const [sid, t] of state.terms) t.tab.classList.toggle("rec", state.rec?.has(sid) ?? false);
    const on = Boolean(state.active && state.rec?.has(state.active));
    $("#rec").classList.toggle("on", on);
    $("#rec").setAttribute("aria-pressed", String(on));
    updateScreensBanner();
}

function toggleRec() {
    const t = state.terms.get(state.active);
    if (!t || t.ended) return toast("aucun terminal actif à enregistrer");
    if (state.rec?.has(state.active)) send({ t: "rec-stop", sid: state.active });
    else send({ t: "rec-start", sid: state.active, cols: t.term.cols, rows: t.term.rows });
}

function renderRecordings(files) {
    const list = $("#rec-list");
    const size = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} Mo` : `${Math.max(1, Math.round(n / 1024))} Ko`);
    list.replaceChildren(...files.slice(0, 20).map((f) => {
        const li = document.createElement("li");
        li.append(
            Object.assign(document.createElement("span"), { className: "j-time", textContent: new Date(f.time).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) }),
            Object.assign(document.createElement("code"), { textContent: f.name.replace(/\.cast$/, ""), title: `${f.name} (et .txt)` }),
            Object.assign(document.createElement("span"), { className: "j-time", textContent: size(f.size) }));
        const play = Object.assign(document.createElement("button"), { type: "button", className: "rec-play", textContent: "▶", title: "Rejouer dans le deck" });
        play.addEventListener("click", () => send({ t: "rec-read", name: f.name }));
        li.append(play);
        return li;
    }));
    if (!files.length) list.append(Object.assign(document.createElement("li"), { className: "hint", textContent: "aucun enregistrement" }));
}

// ---------- Lecteur d'enregistrements (.cast) ----------

const IDLE_MAX = 2;   // pauses plus longues écourtées à 2 s (comme asciinema play -i 2)
let player = null;    // { term, events: [[t, data]], duration, pos (s), index, playing, last, raf }

/** Ouvre le lecteur : terminal en lecture seule, à la taille de l'enregistrement. */
function startPlayer(name, cast) {
    closePlayer();
    const lines = cast.split("\n").filter(Boolean);
    let header;
    try { header = JSON.parse(lines[0]); } catch { return toast("enregistrement illisible"); }
    const events = [];
    let shift = 0;
    let prev = 0;
    for (const line of lines.slice(1)) {
        try {
            const [t, type, data] = JSON.parse(line);
            if (type !== "o") continue;
            if (t - prev > IDLE_MAX) shift += t - prev - IDLE_MAX;
            prev = t;
            events.push([t - shift, data]);
        } catch { /* ligne tronquée */ }
    }
    const cols = Number(header.width) || 100;
    const rows = Number(header.height) || 30;
    $("#player").hidden = false;
    const box = $("#player-screen");
    // Police ajustée pour que la largeur d'origine tienne dans la fenêtre
    const fontSize = Math.max(8, Math.min(14, Math.floor((box.clientWidth - 16) / (cols * 0.61))));
    // Fond opaque assorti au thème : le thème des terminaux est transparent (fond de la page), ce qui donnerait
    // ici un fond noir sous un texte foncé en mode clair
    const background = currentMode === "light" ? "#ffffff" : "#000000";
    box.style.background = background;
    const term = new Terminal({ cols, rows, fontSize, disableStdin: true, cursorBlink: false, scrollback: 2000, theme: { ...termTheme(), background }, fontFamily: "'Cascadia Mono', Consolas, 'SF Mono', Menlo, Monaco, 'DejaVu Sans Mono', monospace" });
    term.open(box);
    player = { term, events, duration: events.at(-1)?.[0] ?? 0, pos: 0, index: 0, playing: false, last: 0, raf: 0 };
    $("#player-title").textContent = name.replace(/\.cast$/, "");
    playerToggle(true);
    $("#player-play").focus();
}

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function playerTick(now) {
    if (!player?.playing) return;
    const speed = Number($("#player-speed").value) || 1;
    player.pos += ((now - player.last) / 1000) * speed;
    player.last = now;
    let chunk = "";
    while (player.index < player.events.length && player.events[player.index][0] <= player.pos) chunk += player.events[player.index++][1];
    if (chunk) player.term.write(chunk);
    if (player.index >= player.events.length) {
        player.pos = player.duration;
        playerToggle(false);
    }
    playerProgress();
    if (player.playing) player.raf = requestAnimationFrame(playerTick);
}

function playerProgress() {
    $("#player-time").textContent = `${mmss(player.pos)} / ${mmss(player.duration)}`;
    $("#player-seek").value = player.duration ? Math.round((player.pos / player.duration) * 1000) : 1000;
}

function playerToggle(play = !player?.playing) {
    if (!player) return;
    if (play && player.index >= player.events.length) playerSeek(0);   // fin atteinte : on recommence
    player.playing = play;
    $("#player-play").textContent = play ? "❚❚" : "▶";
    cancelAnimationFrame(player.raf);
    if (play) {
        player.last = performance.now();
        player.raf = requestAnimationFrame(playerTick);
    }
}

/** Saut à une position : terminal remis à zéro puis tout ce qui précède réécrit d'un coup. */
function playerSeek(seconds) {
    if (!player) return;
    player.term.reset();
    player.pos = Math.max(0, Math.min(seconds, player.duration));
    player.index = 0;
    let chunk = "";
    while (player.index < player.events.length && player.events[player.index][0] <= player.pos) chunk += player.events[player.index++][1];
    player.term.write(chunk);
    playerProgress();
}

function closePlayer() {
    if (!player) { $("#player").hidden = true; return; }
    cancelAnimationFrame(player.raf);
    player.term.dispose();
    player = null;
    $("#player-screen").replaceChildren();
    $("#player").hidden = true;
}

function refreshToolbar() {
    for (const [id, on] of [["#broadcast", state.broadcast], ["#notify", state.notify]]) {
        $(id).classList.toggle("on", on);
        $(id).setAttribute("aria-pressed", String(on));
    }
}

$("#new-tab").addEventListener("click", () => openTerm());
$("#broadcast").addEventListener("click", toggleBroadcast);
$("#rec").addEventListener("click", toggleRec);
$("#rec-open").addEventListener("click", () => send({ t: "rec-open" }));
$("#player-play").addEventListener("click", () => playerToggle());
$("#player-close").addEventListener("click", closePlayer);
$("#player").addEventListener("mousedown", (ev) => { if (ev.target.id === "player") closePlayer(); });
$("#player-seek").addEventListener("input", (ev) => { if (player) playerSeek((Number(ev.target.value) / 1000) * player.duration); });
$("#player").addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Escape") { ev.preventDefault(); closePlayer(); }
    // Espace : sur le bouton, c'est son clic natif ; ailleurs dans le lecteur, lecture / pause
    if (ev.key === " " && !["SELECT", "BUTTON", "INPUT"].includes(ev.target.tagName)) { ev.preventDefault(); playerToggle(); }
});

$("#notify").addEventListener("click", toggleNotify);
$("#font-down").addEventListener("click", () => setFontSize(state.fontSize - 1));
$("#font-up").addEventListener("click", () => setFontSize(state.fontSize + 1));
$("#search-open").addEventListener("click", openSearch);
$("#palette-open").addEventListener("click", openPalette);
$("#search-input").addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Enter" || ev.key === "Escape") ev.preventDefault();
    if (ev.key === "Enter") runSearch(ev.shiftKey);
    if (ev.key === "Escape") closeSearch();
});
$("#search-input").addEventListener("input", () => runSearch());
$("#search-prev").addEventListener("click", () => runSearch(true));
$("#search-next").addEventListener("click", () => runSearch());
$("#search-close").addEventListener("click", closeSearch);
$("#palette-input").addEventListener("input", filterPalette);
$("#palette-input").addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        const n = paletteItems.length;
        if (n) paletteIndex = (paletteIndex + (ev.key === "ArrowDown" ? 1 : n - 1)) % n;
        renderPalette();
    }
    // preventDefault : la touche Entrée ne doit pas atteindre le terminal (une commande à compléter serait exécutée)
    if (ev.key === "Enter" || ev.key === "Escape") ev.preventDefault();
    if (ev.key === "Enter") runPalette(paletteIndex);
    if (ev.key === "Escape") closePalette();
});
$("#palette").addEventListener("mousedown", (ev) => { if (ev.target.id === "palette") closePalette(); });
$("#favform").addEventListener("submit", submitFav);
$("#vault-open").addEventListener("click", openVault);
$("#note-preview-toggle").addEventListener("click", () => toggleNotePreview());
$("#note-export").addEventListener("click", exportNote);
$("#note-import").addEventListener("click", () => $("#note-import-file").click());
$("#note-import-file").addEventListener("change", (ev) => importNotes([...ev.target.files]));
$("#act-import").addEventListener("click", () => $("#act-import-file").click());
$("#act-import-file").addEventListener("change", (ev) => readSectionFile(ev.target.files[0]));
$("#act-import-ok").addEventListener("click", importSection);
$("#act-import-cancel").addEventListener("click", () => { actImport = null; $("#act-import-confirm").hidden = true; });
$("#params-form").addEventListener("submit", (ev) => { ev.preventDefault(); submitParams(); });
$("#params-cancel").addEventListener("click", closeParams);
$("#params").addEventListener("mousedown", (ev) => { if (ev.target.id === "params") closeParams(); });
$("#params-form").addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Escape" && !ev.defaultPrevented) { ev.preventDefault(); closeParams(); }
});
$("#note-to-terminal").addEventListener("click", noteToTerminal);
$("#settings-open").addEventListener("click", openSettings);
$("#mission-switch").addEventListener("change", (ev) => send({ t: "mission-activate", id: ev.target.value }));
$("#mission-new").addEventListener("click", () => openMissionForm());
$("#act-section-new").addEventListener("click", () => openSectionForm());
$("#act-section-save").addEventListener("click", saveSection);
$("#act-section-cancel").addEventListener("click", () => { $("#act-section-form").hidden = true; });
$("#act-save").addEventListener("click", saveAction);
$("#act-cancel").addEventListener("click", () => { $("#act-form").hidden = true; });
for (const r of document.querySelectorAll('input[name="act-kind"]')) r.addEventListener("change", syncActionKind);
for (const id of ["#act-section-form", "#act-form"]) {
    $(id).addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter" || ev.target.tagName !== "INPUT" || ev.target.type === "radio" || ev.target.type === "checkbox") return;
        ev.preventDefault();
        (id === "#act-form" ? saveAction : saveSection)();
    });
}
$("#mission-save").addEventListener("click", saveMission);
$("#mission-cancel").addEventListener("click", () => { $("#mission-form").hidden = true; });
$("#mission-form").addEventListener("keydown", (ev) => { if (ev.key === "Enter" && ev.target.tagName === "INPUT") { ev.preventDefault(); saveMission(); } });
$("#set-worlds-reset").addEventListener("click", resetWorldOrder);
$("#server-restart").addEventListener("click", restartServer);
$("#update-check").addEventListener("click", () => {
    $("#update-check").disabled = true;
    $("#update-check").textContent = "Vérification…";
    send({ t: "update-check" });
});
$("#update-apply").addEventListener("click", applyUpdateNow);
$("#journal-export").addEventListener("click", () => send({ t: "journal-export" }));
$("#journal-clear").addEventListener("click", () => {
    const b = $("#journal-clear");
    if (!b.classList.contains("armed")) { b.classList.add("armed"); b.textContent = "Confirmer l'effacement"; return; }
    send({ t: "journal-clear" });
    b.classList.remove("armed");
    b.textContent = "Effacer";
});
$("#server-token").addEventListener("click", renewToken);
$("#server-diagnostic").addEventListener("click", () => {
    $("#server-diagnostic").disabled = true;
    $("#server-diagnostic").textContent = "Diagnostic…";
    send({ t: "diagnostic" });
});
$("#settings-cancel").addEventListener("click", closeSettings);
$("#set-appearance").addEventListener("change", previewAppearance);
$("#set-autohome-on").addEventListener("change", () => { toggleAutoHomeRow(); if ($("#set-autohome-on").checked) $("#set-autohome").focus(); });
$("#fav-export").addEventListener("click", () => send({ t: "fav-export" }));
$("#config-export").addEventListener("click", () => send({ t: "config-export" }));
$("#config-import").addEventListener("click", () => $("#config-import-file").click());
$("#config-import-file").addEventListener("change", (ev) => readConfigFile(ev.target.files[0]));
$("#config-import-go").addEventListener("click", importConfig);
$("#config-import-cancel").addEventListener("click", () => { pendingConfig = null; $("#config-import-confirm").hidden = true; });
$("#fav-import").addEventListener("click", () => $("#fav-import-file").click());
$("#fav-import-file").addEventListener("change", (ev) => readImportFile(ev.target.files[0]));
$("#fav-import-merge").addEventListener("click", () => importFavorites("merge"));
$("#fav-import-replace").addEventListener("click", () => importFavorites("replace"));
$("#fav-import-cancel").addEventListener("click", hideImportConfirm);
$("#vault-export").addEventListener("click", () => send({ t: "vault-export" }));
$("#vault-import").addEventListener("click", () => $("#vault-import-file").click());
$("#vault-import-file").addEventListener("change", (ev) => readVaultFile(ev.target.files[0]));
$("#vault-import-use").addEventListener("click", () => importVault("use"));
$("#vault-import-merge").addEventListener("click", () => importVault("merge"));
$("#vault-import-replace").addEventListener("click", () => importVault("replace"));
$("#vault-import-cancel").addEventListener("click", hideVaultImport);
$("#vault-import-open").addEventListener("click", () => { closeSettings(); openVault(); });
// Entrée dans le mot de passe : action principale de l'import, pas l'enregistrement des réglages
$("#vault-import-pass").addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    importVault(state.vault.exists === false ? "use" : "merge");
});
$("#set-theme").addEventListener("change", previewAppearance);
$("#set-signature-pick").addEventListener("click", () => $("#set-signature-file").click());
$("#set-signature-file").addEventListener("change", (ev) => uploadSignature(ev.target.files[0]));
$("#set-signature-remove").addEventListener("click", () => send({ t: "signature-remove" }));
// Aperçu de la signature pendant la saisie (texte, style, police)
const previewWatermark = () => {
    $("#set-watermark-font-row").hidden = $("#set-watermark-style").value !== "ascii";
    applyWatermark($("#set-watermark").value.trim(), $("#set-watermark-style").value, $("#set-watermark-font").value);
};
$("#set-watermark").addEventListener("input", previewWatermark);
$("#set-watermark-style").addEventListener("change", previewWatermark);
$("#set-watermark-font").addEventListener("change", previewWatermark);
$("#settings").addEventListener("mousedown", (ev) => { if (ev.target.id === "settings") closeSettings(); });
$("#settings-form").addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Escape") { ev.preventDefault(); closeSettings(); }
});
$("#settings-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    // Fermeture immédiate (sans attendre le serveur) ; rouvert si le serveur refuse
    settingsPending = true;
    $("#settings").hidden = true;
    hideImportConfirm();
    hideVaultImport();
    send({ t: "settings-save", settings: {
        autoHomeEnabled: $("#set-autohome-on").checked,
        ...($("#set-autohome-on").checked ? { autoHomeSeconds: Number($("#set-autohome").value) } : {}),
        appearance: $("#set-appearance").value,
        missionTheme: $("#set-theme").value,
        journalEnabled: $("#set-journal-on").checked,
        watermark: $("#set-watermark").value,
        watermarkStyle: $("#set-watermark-style").value,
        watermarkFont: $("#set-watermark-font").value,
        ...(state.worlds ? { worlds: worldChoices(), worldOrder: worldOrderChoice() } : {})
    } });
});
$("#vault-close").addEventListener("click", closeVault);
$("#vault-lock").addEventListener("click", () => { flushNote(); send({ t: "vault-lock" }); });
$("#vault").addEventListener("mousedown", (ev) => { if (ev.target.id === "vault") closeVault(); });
$("#vault").addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
        ev.preventDefault();
        if (!$("#secret-form").hidden) closeSecretForm(); else closeVault();
    }
    ev.stopPropagation();
});
for (const tab of ["notes", "secrets"]) $(`#vault-tab-${tab}`).addEventListener("click", () => { flushNote(); vaultUi.tab = tab; renderVault(); });
$("#vault-locked").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const password = $("#vault-pass").value;
    if (!state.vault.exists) {
        if (password !== $("#vault-pass2").value) return toast("les deux mots de passe sont différents");
        send({ t: "vault-create", password });
    } else {
        send({ t: "vault-unlock", password });
    }
    $("#vault-pass").value = "";
    $("#vault-pass2").value = "";
});
$("#note-new").addEventListener("click", newNote);
$("#note-search").addEventListener("input", renderNotes);
$("#note-title").addEventListener("input", scheduleNote);
$("#note-body").addEventListener("input", scheduleNote);
$("#note-delete").addEventListener("click", () => armOrRun($("#note-delete"), "Confirmer la suppression", () => {
    send({ t: "note-delete", id: vaultUi.noteId });
    vaultUi.noteId = null;
    clearTimeout(noteTimer);
    noteTimer = null;
    loadNoteInEditor();
}));
$("#secret-new").addEventListener("click", () => openSecretForm());
$("#secret-search").addEventListener("input", renderSecrets);
$("#secret-cancel").addEventListener("click", closeSecretForm);
$("#secret-show").addEventListener("click", () => { const i = $("#secret-value"); i.type = i.type === "password" ? "text" : "password"; });
$("#secret-gen").addEventListener("click", () => { $("#secret-value").value = generatePassword(); $("#secret-value").type = "text"; });
$("#secret-delete").addEventListener("click", () => armOrRun($("#secret-delete"), "Confirmer la suppression", () => {
    send({ t: "secret-delete", id: vaultUi.secretEditing.id });
    closeSecretForm();
}));
$("#secret-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    send({ t: "secret-save", id: vaultUi.secretEditing?.id, name: $("#secret-name").value, user: $("#secret-user").value,
        url: $("#secret-url").value, note: $("#secret-note").value, value: $("#secret-value").value });
});
$("#fav-cancel").addEventListener("click", closeFavForm);
$("#fav-remove").addEventListener("click", () => {
    if (!favEditing) return;
    // Groupe non vide : un premier clic annonce ce qui sera supprimé, le second confirme
    const inside = favEditing.favGroup ? countInside(favEditing.fav) : 0;
    if (inside && !favRemoveArmed) {
        favRemoveArmed = true;
        $("#fav-remove").textContent = `Confirmer : supprimer le groupe et ses ${inside} élément${inside > 1 ? "s" : ""}`;
        return;
    }
    send({ t: "fav-remove", id: favEditing.fav });
});
for (const input of document.querySelectorAll("#fav-kind input")) input.addEventListener("change", syncFavKind);

/** Nombre d'éléments (sites et sous-groupes, à tous les niveaux) dans un groupe. */
function countInside(groupId) {
    return (state.pages[`fav-${groupId}`] ?? []).filter((k) => k?.fav)
        .reduce((n, k) => n + 1 + (k.favGroup ? countInside(k.fav) : 0), 0);
}
for (const [id, delta] of [["#fav-left", -1], ["#fav-right", 1]]) {
    $(id).addEventListener("click", () => {
        if (!favEditing) return;
        favMoving = true;
        send({ t: "fav-move", id: favEditing.fav, delta });
    });
}
$("#favdialog").addEventListener("mousedown", (ev) => { if (ev.target.id === "favdialog") closeFavForm(); });
$("#favform").addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Escape") closeFavForm();
});
document.addEventListener("mousedown", (ev) => {
    if (!$("#picker").hidden && !ev.target.closest("#picker, .key.status")) closePicker();
});
window.addEventListener("resize", () => { if (!$("#picker").hidden) placePicker(); });

/** Raccourcis : Cmd/Ctrl+K palette, Cmd/Ctrl+F recherche, Cmd/Ctrl + / − / 0 taille du texte, Échap ferme. */
document.addEventListener("keydown", (ev) => {
    // Coffre ou formulaire des favoris ouverts : leurs champs gardent les raccourcis du navigateur
    // Réglages ouverts sans champ actif : Échap ferme le panneau
    if (!$("#settings").hidden && ev.key === "Escape") { ev.preventDefault(); closeSettings(); return; }
    if (!$("#vault").hidden || !$("#favdialog").hidden || !$("#settings").hidden || !$("#params").hidden) return;
    const mod = macClient ? ev.metaKey : ev.ctrlKey;
    const key = ev.key.toLowerCase();
    let handled = true;
    if (mod && !ev.altKey && key === "k") openPalette();
    else if (mod && !ev.altKey && key === "f") openSearch();
    else if (mod && !ev.altKey && (key === "=" || key === "+")) setFontSize(state.fontSize + 1);
    else if (mod && !ev.altKey && key === "-") setFontSize(state.fontSize - 1);
    else if (mod && !ev.altKey && key === "0") setFontSize(14);
    else if (key === "escape" && !$("#picker").hidden) closePicker();
    else handled = false;
    if (handled) {
        ev.preventDefault();
        ev.stopPropagation();
    }
}, true);
refreshToolbar();
document.querySelector(".kbd-mod").textContent = macClient ? "⌘K" : "Ctrl+K";
for (const btn of document.querySelectorAll("#layouts button")) btn.addEventListener("click", () => setLayout(btn.dataset.layout));
new ResizeObserver(fitVisible).observe($("#screens"));

// ---------- Un seul onglet du deck par navigateur ----------
// Double-clic sur le lanceur alors que le navigateur restaure sa session (ou deck déjà ouvert) :
// le plus récent des onglets se ferme (ou se met en veille) au lieu d'ouvrir des terminaux en double.

const tabId = crypto.randomUUID();
const tabStart = performance.timeOrigin;
let started = false;

/** L'onglet a démarré avant l'autre (à égalité, le plus petit identifiant gagne). */
const olderThan = (at, id) => tabStart < at || (tabStart === at && tabId < id);

function startDeck() {
    if (started) return;
    started = true;
    $("#duplicate").hidden = true;
    connect();
}

function duplicateTab() {
    if (started) return;
    window.close();   // possible pour un onglet ouvert par le lanceur (une seule page dans son historique)
    // Fermeture refusée par le navigateur : l'onglet reste en veille, sans se connecter
    setTimeout(() => { if (!started) $("#duplicate").hidden = false; }, 300);
}

if ("BroadcastChannel" in window) {
    const channel = new BroadcastChannel("web-deck-devsecops");
    channel.onmessage = ({ data }) => {
        if (data?.t === "probe" && data.id !== tabId && olderThan(data.at, data.id)) {
            channel.postMessage({ t: "older", to: data.id });
        }
        if (data?.t === "older" && data.to === tabId) duplicateTab();
    };
    channel.postMessage({ t: "probe", id: tabId, at: tabStart });
    $("#duplicate-use").addEventListener("click", startDeck);
    // Pas de réponse d'un onglet plus ancien : c'est le seul deck ouvert
    setTimeout(() => { if ($("#duplicate").hidden) startDeck(); }, 400);
} else {
    startDeck();
}
