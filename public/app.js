// Page du deck : grille de touches (rubriques, voyants) et terminaux xterm.js reliés au serveur.
import { Terminal } from "/vendor/xterm.mjs";
import { FitAddon } from "/vendor/addon-fit.mjs";
import { WebLinksAddon } from "/vendor/addon-web-links.mjs";
import { SearchAddon } from "/vendor/addon-search.mjs";
import { toAnsi, toHtml } from "/markdown.js";
import { setLang, sourceText, currentLang, t as tr } from "/i18n.js";
import { patchPlan, patchRisks, planMarkdown } from "/patch-plan.js";

/** Langue des dates affichées (jour/mois dans les deux cas : en-GB plutôt que en-US). */
const dateLocale = () => (currentLang() === "en" ? "en-GB" : "fr-FR");

const $ = (sel) => document.querySelector(sel);

// Passage par les favoris depuis une rubrique : { page } de départ ; retour après le choix ou au bout de 30 s
const FAV_RETURN_S = 30;
let favReturn = null;

/** Version de la page chargée (empreinte envoyée par le serveur dans « hello »). */
let pageBuild = null;

const state = {
    ws: null,
    tools: { missing: new Set(), install: {} },   // outils installables absents (server/tools.mjs)
    localUnix: true,                              // poste Linux / macOS (sinon : rubriques "unix" via ssh / wsl)
    remote: {},                                   // sid -> "ssh" | "wsl" : terminaux connectés (server/remote.mjs)
    remoteTargets: {},                            // sid -> { dest, vm, env } : destination (VM de l'inventaire reconnue)
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
            if (msg.proxy) applyProxy(msg.proxy);
            state.workspace = msg.workspace ?? "";
            state.actions = msg.actions ?? [];
            state.prodPatternDefault = msg.prodPattern ?? "prod";
            state.signature = msg.signature ?? null;
            applyWatermark();
            state.remote = msg.remote ?? {};
            state.remoteTargets = msg.remoteTargets ?? {};
            if (msg.tools) applyTools(msg.tools);
            state.status = msg.status ?? {};
            if (msg.vault) applyVault(msg.vault);
            if (msg.settings) {
                state.settings = msg.settings;
                setTimeout(() => setLang(msg.settings.language));
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
            setLang(msg.settings.language);
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
            state.remoteTargets = msg.targets ?? {};
            markRemoteTabs();
            updateScreensBanner();
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
        case "secret-read":
            secretWaits.get(msg.req)?.resolve();
            secretWaits.delete(msg.req);
            break;
        case "report":
            $("#report-text").value = msg.markdown;
            $("#report-build").disabled = false;
            $("#report-build").textContent = "Générer";
            break;
        case "cert-alert":
            certAlert(msg.alerts);
            break;
        case "patch-survey":
            if (!msg.ok) { toast(`relevé reçu de ${msg.host} : aucune VM de l'inventaire ne correspond (connecte le terminal à la VM, ou ajoute-la)`, "ko"); break; }
            toast(`relevé de ${msg.vm} : ${surveyText(msg.check)}${msg.lastChanged !== null ? ` · dernier patch ${frDate(msg.lastPatch)}${msg.nextPatch ? `, prochain ${frDate(msg.nextPatch)}` : ""}` : ""}`, msg.check.security ? "ko" : "ok");
            break;
        case "patches":
            state.patches = msg.vms;
            state.patchClusters = msg.clusters ?? {};
            renderPatchDash();
            if (patchVipEditing) { $("#patch-vip-form").hidden = true; patchVipEditing = null; }
            renderPatches();
            if (!$("#agenda").hidden) send({ t: "agenda" });
            break;
        case "proxy":
            applyProxy(msg.proxy);
            // Changement détecté en mode automatique (arrivée au bureau, retour à la maison)
            if (msg.changed && msg.proxy.mode === "auto") toast(msg.proxy.active ? `proxy du bureau détecté : connexions par ${msg.proxy.url}` : "proxy injoignable : connexion directe (hors du bureau)", "ok");
            break;
        case "agenda":
            agendaEvents = msg.events;
            renderAgenda();
            if (msg.ics) {
                downloadText(msg.ics, `echeances-${new Date().toISOString().slice(0, 10)}.ics`, "text/calendar;charset=utf-8");
                toast(`${msg.events.length} échéance(s) exportée(s) : ouvre le fichier .ics (Téléchargements) avec Outlook ou Google Agenda`, "ok");
            }
            break;
        case "summary":
            summaryMarkdown = msg.markdown;
            $("#summary-view").innerHTML = toHtml(msg.markdown);   // HTML échappé par markdown.js
            $("#summary-refresh").disabled = false;
            break;
        case "patch-saved":
            patchPending = false;
            $("#patch-form").hidden = true;
            toast(msg.demoted?.length ? `${msg.name} devient PRIMARY · ${msg.demoted.join(", ")} repasse SECONDARY` : "VM enregistrée", "ok");
            break;
        case "patch-alert":
            patchAlert(msg.alerts);
            break;
        case "patch-import":
            showPatchImport(msg);
            break;
        case "patch-export":
            downloadText(msg.csv, `vms-patchs-${new Date().toISOString().slice(0, 10)}.csv`, "text/csv;charset=utf-8");
            toast("inventaire exporté en CSV (dans Téléchargements)", "ok");
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
            toast(msg.mode === "merge" ? `coffre fusionné : ${msg.added} ajouté(s), ${msg.updated} mis à jour${msg.renamed ? `, ${msg.renamed} secret(s) renommé(s) « -importe » (nom déjà pris)` : ""} (fichier : ${n})`
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
            // Formulaire de VM : l'erreur s'affiche dans le formulaire (saisie gardée)
            if (patchPending) { patchPending = false; $("#patch-error").textContent = msg.error; $("#patch-error").hidden = false; }
            else if (patchVipEditing && !$("#patch-vip-form").hidden) { $("#patch-vip-error").textContent = msg.error; $("#patch-vip-error").hidden = false; }
            // Secret en cours de lecture : la commande n'est pas tapée
            for (const w of secretWaits.values()) w.reject(new Error(msg.error));
            secretWaits.clear();
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
    const { left, right } = rowOrder(withPinnedFavorites(state.pages[state.page] ?? []));
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

const dialogOpen = () => ["#settings", "#vault", "#favdialog", "#palette", "#picker", "#duplicate", "#params", "#player", "#report", "#docs", "#patches", "#agenda", "#summary", "#patch-dash"].some((id) => $(id) && !$(id).hidden);

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

/**
 * Touche Favoris toujours à portée de main : fixée à gauche de clear sur toutes les pages hors favoris (sur
 * l'accueil, elle remplace la touche Favoris de la rangée). Absente si la rubrique Favoris est décochée.
 */
function withPinnedFavorites(keys) {
    if (isFavPage(state.page)) return keys;
    const source = (state.pages.root ?? []).find((k) => k?.type === "folder" && k.page === "favoris");
    if (!source) return keys;
    const pinned = { ...source, id: "pin-favoris", right: true, pinnedFav: true };
    const rest = state.page === "root" ? keys.filter((k) => k !== source) : keys;
    return [...rest, pinned];
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
    // Favoris et rubriques personnelles (« u-… ») : noms saisis, jamais traduits
    if (key.fav || key.favGroup || String(key.id ?? "").startsWith("u-")) label.dataset.noI18n = "";
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
    // Certificats et patchs : nom d'hôte / de VM sur une seule ligne (tronqué), le pied de touche reste visible
    const lines = Object.assign(document.createElement("span"), { className: `lines${["certs", "patches"].includes(statusId) ? " one-line" : ""}` });
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
        if (statusId === "patches") return openPatches();
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
    if (favReturn && !isFavPage(page)) favReturn = null;
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
    // Production avec comparaison (helm upgrade, kubectl apply) : 1er clic = diff tapé, 2e clic (60 s) = vraie commande
    if (key.prodGuard && key.diff && prodContext() && prodArmed?.id !== key.id) return armDiffKey(key);
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
            const target = group && state.pages[`fav-${group}`] ? `fav-${group}` : key.page;
            // Favoris ouverts depuis une rubrique : retour à cette rubrique après le choix, ou au bout de 30 s
            if (key.page === "favoris" && !isFavPage(state.page)) {
                const from = state.page;
                go(target);
                favReturn = { page: from };
                return armAutoHome();
            }
            return go(target);
        }
        case "back":
            // Haut des favoris ouverts depuis une rubrique : Retour ramène à cette rubrique
            if (favReturn && isFavPage(state.page) && (key.page ?? "root") === "root") return backFromFavorites();
            return go(key.page ?? "root");
        case "web":
            if (key.fav && state.favEdit) return openFavForm(key);
            journalAction(key, key.url, "link");
            window.open(key.url, "_blank", "noopener,noreferrer");
            // Site choisi dans les favoris ouverts depuis une rubrique : retour à cette rubrique
            if (favReturn && isFavPage(state.page)) backFromFavorites();
            return;
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
            if (key.enter) return typeCommand(key, command, true);
            // Commande à compléter : le texte sélectionné dans le terminal est ajouté à la fin (sans Entrée)
            return typeCommand(key, withSelection(command), false);
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
const LIVE = ["namespace", "ns", "pod", "deployment", "deploy", "service", "svc", "node", "context", "ctx", "contexte", "container", "conteneur", "image", "host", "hote", "hôte", "serveur", "server", "identity", "identite", "identité", "port", "instance", "noeud", "nœud"];
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
const isHost = (name) => /^(host|hote|hôte|serveur|server)$/i.test(name);
const NAMESPACED = /^(pod|deployment|deploy|service|svc)$/i;
const PARAM_NOUN = { pod: "pod", deployment: "deployment", deploy: "deployment", service: "service", svc: "service" };

function openParams(key, command) {
    // Hôte avant la clé SSH : on choisit la VM, sa clé est reprise de l'inventaire
    const names = namedParams(command).sort((a, b) => (/^identit/i.test(a) && isHost(b) ? 1 : /^identit/i.test(b) && isHost(a) ? -1 : 0));
    paramsState = { key, command, names, req: crypto.randomUUID(), options: new Map(), labels: new Map(), identities: {} };
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
        // sid : terminal actif (nœuds MySQL du cluster de la VM sur laquelle il est connecté)
        send({ t: "param-options", req: paramsState.req, name, namespace: ns, service, sid: state.active });
    }
}

function applyParamOptions(msg) {
    // Clés SSH pour le formulaire d'une VM (Patchs)
    if (msg.req === "patch-identity") {
        $("#patch-identity-list").replaceChildren(...(msg.options ?? []).map((o) => new Option(o.replace(/^"(.*)"$/, "$1"))));
        return;
    }
    if (!paramsState || msg.req !== paramsState.req) return;
    const ns = [...$("#params-fields").querySelectorAll("input")].find((i) => isNs(i.dataset.name))?.value.trim();
    for (const input of $("#params-fields").querySelectorAll("input")) {
        if (input.dataset.name !== msg.name) continue;
        // Liste réelle, valeurs récemment utilisées en tête (seulement celles qui existent encore)
        // Hôtes : VMs de l'inventaire en tête, dans l'ordre de l'inventaire (pas de réordonnancement par l'historique)
        const recent = msg.inventory ? [] : paramHistory(msg.name).filter((v) => msg.options.includes(v));
        const options = [...recent, ...msg.options.filter((o) => !recent.includes(o))];
        if (msg.labels) for (const [v, l] of Object.entries(msg.labels)) paramsState.labels.set(v, l);
        if (msg.identities) Object.assign(paramsState.identities, msg.identities);
        const noun = PARAM_NOUN[msg.name.toLowerCase()];
        const status = msg.error ? `liste indisponible : ${msg.error} (saisie libre possible)`
            : !options.length && noun && ns ? `aucun ${noun} dans le namespace « ${ns} » : choisis un autre namespace`
            : !options.length ? "liste vide (saisie libre possible)"
            : msg.inventory && /^(instance|noeud|nœud)$/i.test(msg.name) ? (msg.cluster ? `nœuds du cluster ${msg.cluster} (VM connectée) : clique ou ↑ ↓ puis Entrée` : `${msg.inventory} nœud(s) MySQL de l'inventaire (terminal non connecté à un nœud connu)`)
            : !options.length && /^(instance|noeud|nœud)$/i.test(msg.name) ? "aucun nœud dans l'inventaire : renseigne le cluster de tes VMs (Patchs), ou tape hôte:3306"
            : msg.inventory ? `${msg.inventory} VM(s) de l'inventaire en tête, puis ~/.ssh/config : clique ou ↑ ↓ puis Entrée`
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
    const labels = paramsState?.labels ?? new Map();
    const options = (paramsState?.options.get(input.id) ?? []).filter((o) => fold(`${o} ${labels.get(o) ?? ""}`).includes(filter)).slice(0, 200);
    list.replaceChildren(...options.map((o, i) => {
        const li = Object.assign(document.createElement("li"), { textContent: o, className: i === 0 && filter ? "sel" : "" });
        li.dataset.value = o;
        // VM de l'inventaire : nom et environnement à droite de l'hôte
        if (labels.has(o)) li.append(Object.assign(document.createElement("span"), { className: "param-label", textContent: labels.get(o) }));
        li.setAttribute("role", "option");
        li.addEventListener("mousedown", (ev) => { ev.preventDefault(); pickParam(input, o); });
        return li;
    }));
    list.hidden = !options.length;
}

/** Valeur choisie : champ rempli, liste fermée, champ suivant (ou bouton) ; un namespace recharge les pods. */
function pickParam(input, value) {
    input.value = value;
    // VM de l'inventaire choisie : sa clé SSH remplit {identity} s'il est vide (guillemets si le chemin a des espaces)
    const identity = isHost(input.dataset.name) && paramsState?.identities?.[value];
    if (identity) {
        const keyInput = [...$("#params-fields").querySelectorAll("input")].find((x) => /^identit/i.test(x.dataset.name));
        if (keyInput && !keyInput.value.trim()) keyInput.value = /\s/.test(identity) ? `"${identity}"` : identity;
    }
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
        pickParam(input, items[cur].dataset.value ?? items[cur].textContent);
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
    typeCommand(key, command, key.enter);
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
            Object.assign(document.createElement("span"), { className: "j-time", textContent: `${time.toLocaleDateString(dateLocale(), { day: "2-digit", month: "2-digit" })} ${time.toLocaleTimeString(dateLocale(), { hour: "2-digit", minute: "2-digit" })}` }),
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

// ---------- Secrets dans les commandes : {secret:Nom du secret} ----------

const SECRET_RE = /\{secret:([^{}\r\n]{1,80})\}/g;
const secretWaits = new Map();   // req -> { resolve, reject }

/**
 * Tape une commande (journalisée) ; si elle contient {secret:Nom}, chaque secret est d'abord lu par le shell,
 * sans écho, dans DECK_SECRET_n (le serveur lui transmet la valeur), et la commande utilise la variable,
 * effacée juste après. La valeur ne passe ni par la page, ni par l'écran, ni par l'historique, ni par le journal.
 */
async function typeCommand(key, command, enter) {
    const names = [...new Set([...command.matchAll(SECRET_RE)].map((m) => m[1].trim()))];
    if (!names.length) {
        journalAction(key, command, enter ? "run" : "type");
        return typeInTerminal(enter ? `${command}\r` : command);
    }
    const t = state.terms.get(state.active);
    if (!t || t.ended) return toast("aucun terminal actif pour lire le secret");
    if (state.broadcast) return toast("secret : désactive d'abord la diffusion (il ne serait lu que dans un terminal)");
    if (!state.vault.unlocked) { openVault(); return toast("déverrouille le coffre : la commande utilise un secret"); }
    // Terminal connecté en ssh : shell distant de type Unix ; sinon le shell local
    const kind = state.remote[state.active] ? "posix" : activeKind();
    if (kind === "cmd") return toast("secret : non pris en charge dans cmd (utilise PowerShell ou Git Bash)");
    const matches = names.map((n) => state.vault.secrets.filter((s) => s.name.trim().toLowerCase() === n.toLowerCase()));
    const missing = names.find((n, i) => !matches[i].length);
    if (missing) return toast(`secret « ${missing} » introuvable dans le coffre (nom exact attendu)`);
    // Ancien coffre avec deux secrets du même nom : on ne devine pas lequel utiliser
    const twin = names.find((n, i) => matches[i].length > 1);
    if (twin) return toast(`plusieurs secrets s'appellent « ${twin} » : renomme l'un d'eux dans le coffre (Modifier)`);
    const ids = matches.map((m) => m[0]);
    let final = command;
    try {
        for (const [i, secret] of ids.entries()) {
            const req = crypto.randomUUID();
            const wait = new Promise((resolve, reject) => secretWaits.set(req, { resolve, reject }));
            send({ t: "secret-read", sid: state.active, id: secret.id, kind, n: i + 1, req });
            await wait;
            const ref = kind === "powershell" ? `$DECK_SECRET_${i + 1}` : `"$DECK_SECRET_${i + 1}"`;
            final = final.replace(SECRET_RE, (all, n) => (n.trim().toLowerCase() === names[i].toLowerCase() ? ref : all));
        }
    } catch {
        return;   // message déjà affiché (erreur du serveur)
    }
    const vars = names.map((_, i) => `DECK_SECRET_${i + 1}`);
    final += kind === "powershell" ? `; Remove-Variable ${vars.join(",")}` : `; unset ${vars.join(" ")}`;
    journalAction(key, final, enter ? "run" : "type");
    // Laisse le shell terminer la lecture (sinon la commande s'affiche deux fois)
    await new Promise((r) => setTimeout(r, 400));
    typeInTerminal(enter ? `${final}\r` : final);
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
    label.dataset.noI18n = "";   // nom du terminal (renommable) : jamais traduit
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
    markRemoteTabs();   // garde le nom de la machine connectée dans l'étiquette de l'écran
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
    // Machine connectée : cadre et étiquette sur le terminal lui-même (markRemoteTabs), pas dans ce bandeau
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
            const n = new Notification(tr(`Deck : « ${t.title ?? t.defaultTitle} » a terminé`), { body: tr("La commande ne produit plus de sortie."), icon: "/img/icon-64.png", tag: `deck-${sid}` });
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
        const row = Object.assign(document.createElement("div"), { className: `picker-row${item.current ? " current" : ""}${item.prod ? " prod" : ""}${item.alert ? " alert" : ""}` });
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

/** Ports TLS qui ne sont pas des sites web : pas de lien ↗ (LDAPS, IMAPS, POP3S, SMTPS, AMQPS, MQTTS…). */
const NON_WEB_TLS_PORTS = new Set(["636", "993", "995", "465", "587", "5671", "8883", "6697", "989", "990", "3269", "5986"]);

function renderCertsPanel(checking = false) {
    if ($("#picker").hidden || pickerAnchor?.dataset.status !== "certs") return;
    const s = state.status.certs ?? { items: [] };
    const row = (c) => {
        // Niveau calculé par le serveur selon l'environnement (production 30 / 7 j, hors production 14 / 3 j)
        const level = c.level ?? (c.days < 7 ? "rouge" : c.days < 30 ? "orange" : "ok");
        const dot = c.error ? "⚪" : c.intercepted ? "⚠️" : level === "rouge" ? "🔴" : level === "orange" ? "🟠" : "🟢";
        const env = c.env && c.env !== "production" ? `[${c.env}] ` : "";
        // Chemin : le proxy est indiqué une fois en bas du panneau ; ici seulement le repli en direct
        const route = c.direct ? " · en direct" : "";
        const when = c.error ? c.error
            : c.intercepted ? `certificat du proxy (${c.issuer}) : la date du site n'est pas visible d'ici`
            : `${c.days < 0 ? `expiré depuis ${-c.days} j` : `${c.days} j`} · ${new Date(c.until).toLocaleDateString(dateLocale())} · ${c.issuer || "émetteur inconnu"}${c.trusted ? "" : " · chaîne non reconnue"}${route}`;
        const title = [c.target, c.reason, c.via && !c.direct ? `via le proxy ${c.via}` : "", c.direct ? "le proxy n'atteint pas cet hôte : certificat lu en direct" : ""].filter(Boolean).join("\n");
        // Lien vers le site : https://hôte (port 443) ou https://hôte:port ; pas pour les ports non web (LDAP, mail…)
        const [host, port = "443"] = c.target.split(":");
        const url = NON_WEB_TLS_PORTS.has(port) ? null : `https://${host}${port === "443" ? "" : `:${port}`}/`;
        const open = () => window.open(url, "_blank", "noopener,noreferrer");
        return {
            label: `${dot} ${env}${c.target} : ${when}`, title: url ? `${title}\nClic : ouvrir ${url}` : title,
            onClick: url ? open : () => {},
            // Rouge (urgent) : texte en rouge, sans la confirmation « production » des contextes kubectl
            alert: !c.error && !c.intercepted && level === "rouge",
            actions: url ? [{ label: "↗", title: `Ouvrir ${url} dans le navigateur`, onClick: open }] : []
        };
    };
    // Production d'abord (seuils 30 / 7 j), puis les autres environnements (14 / 3 j), puis ce qui n'a pas pu être lu
    const all = s.items ?? [];
    const readable = all.filter((c) => !c.error);
    const failed = all.filter((c) => c.error);
    const prod = readable.filter((c) => (c.env ?? "production") === "production").map(row);
    const others = readable.filter((c) => (c.env ?? "production") !== "production").map(row);
    const sections = [];
    if (prod.length || !all.length) sections.push(pickerSection("Production · alerte à 30 et 7 jours", prod, "aucun certificat : Réglages › Missions › Modifier › Certificats à surveiller"));
    if (others.length) sections.push(pickerSection("Hors production · alerte à 14 et 3 jours", others, ""));
    if (failed.length) {
        sections.push(pickerSection(`Injoignables d'ici (${failed.length}) · expiration inconnue`, failed.map(row), ""));
        sections.push(Object.assign(document.createElement("p"), { className: "picker-note certs-hint",
            textContent: "Ni par le proxy ni en direct : hôte interne hors VPN, nom mal saisi, ou port différent (hôte:port). Vérifie l'adresse, ou lance la vérification depuis le réseau du client." }));
    }
    const proxies = [...new Set(all.map((c) => c.via).filter(Boolean))];
    const direct = all.filter((c) => c.direct).length;
    const route = proxies.length ? ` · proxy ${proxies.join(", ")}${direct ? ` (${direct} lu(s) en direct, hors d'atteinte du proxy)` : ""}` : "";
    const foot = Object.assign(document.createElement("p"), { className: "picker-note",
        textContent: checking ? "vérification en cours…" : `vérifié à ${new Date(s.checked ?? Date.now()).toLocaleTimeString(dateLocale(), { hour: "2-digit", minute: "2-digit" })} · ensuite toutes les 30 min${route}` });
    const again = Object.assign(document.createElement("button"), { type: "button", className: "picker-action", textContent: "Vérifier maintenant" });
    again.addEventListener("click", () => { renderCertsPanel(true); send({ t: "press", id: "certs" }); });
    const cal = Object.assign(document.createElement("button"), { type: "button", className: "picker-action", textContent: "Calendrier", title: "Échéances (certificats et patchs), export Outlook" });
    cal.addEventListener("click", openAgenda);
    foot.append(" ", again, " ", cal);
    $("#picker").classList.add("certs-panel");
    $("#picker").replaceChildren(...sections, foot);
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
        const when = new Date(r.time).toLocaleString(dateLocale(), { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
        entries.push({ key: { label: r.command, icon: "lucide-history", color: "#546e7a" }, where: `Récent · ${when}`, detail: `${r.label}${r.kube ? ` · ${r.kube}` : ""} · tapée sans Entrée`, hay: `recent récent ${r.label} ${r.command}`.toLowerCase(), run: () => typeInTerminal(r.command) });
    }
    for (const m of state.settings?.missions ?? []) {
        const active = m.id === state.settings.activeMission;
        entries.push({ key: { label: m.name, icon: "lucide-briefcase", color: m.color || "#00897b" }, where: "Mission", detail: active ? "mission active : Entrée pour la désactiver" : "activer cette mission", hay: `mission ${m.name}`.toLowerCase(), run: () => send({ t: "mission-activate", id: active ? "" : m.id }) });
    }
    entries.push({ key: { type: "vault", label: "Coffre : notes et secrets", icon: "lock", color: "#5c6bc0" }, where: "Coffre", detail: "notes et secrets chiffrés", hay: "coffre vault notes secrets mots de passe tokens password" });
    entries.push({ key: { label: "Échéances", icon: "lucide-calendar-check", color: "#00838F" }, where: "Suivi", detail: "calendrier des patchs et certificats, export Outlook (.ics)", hay: "echeances calendrier agenda outlook ics patchs certificats expiration", run: openAgenda });
    entries.push({ key: { label: "Tableau de bord des patchs", icon: "lucide-layout-dashboard", color: "#00838F" }, where: "Suivi", detail: "VMs, patchs par environnement, prochaines semaines, clusters, tags", hay: "tableau de bord dashboard statistiques stats patchs vms clusters environnements", run: openPatchDash });
    entries.push({ key: { label: "Synthèse du client", icon: "lucide-clipboard-list", color: "#00838F" }, where: "Suivi", detail: "état de la mission : certificats, patchs, échéances, actions en production", hay: "synthese client mission etat parc point hebdo comite", run: openSummary });
    entries.push({ key: { label: "Rapport d'intervention", icon: "lucide-file-text", color: "#00838F" }, where: "Suivi", detail: "compte rendu d'une période (journal, sessions, patchs, état du parc)", hay: "rapport intervention compte rendu", run: openReport });
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
            Object.assign(document.createElement("span"), { className: "vault-item-title", textContent: n.title, translate: false }),
            Object.assign(document.createElement("span"), { className: "vault-item-sub", textContent: n.body.split("\n")[0].slice(0, 80) || "—", translate: false })
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
    $("#note-status").textContent = note ? `modifiée le ${new Date(note.updated).toLocaleString(dateLocale())}` : "";
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
            Object.assign(document.createElement("span"), { className: "vault-item-title", textContent: s.name, translate: false }),
            Object.assign(document.createElement("span"), { className: "vault-item-sub", textContent: [s.user, s.url].filter(Boolean).join(" · ") || "—", translate: false }),
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
const autoHome = { world: null, deadline: 0, total: 0, timer: null, last: 0, target: "root" };


function backFromFavorites() {
    const page = favReturn?.page ?? "root";
    favReturn = null;
    cancelAutoHome();
    go(page);
    if (page !== "root") armAutoHome();   // la rubrique retrouve son propre retour à l'accueil
}

function armAutoHome() {
    const inFavReturn = Boolean(favReturn && isFavPage(state.page));
    const seconds = inFavReturn ? FAV_RETURN_S : state.settings.autoHomeEnabled === false ? 0 : Number(state.settings.autoHomeSeconds) || 0;
    autoHome.target = inFavReturn ? favReturn.page : "root";
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
    $("#autohome").title = autoHome.target !== "root"
        ? `retour à « ${state.titles[autoHome.target] ?? autoHome.target} » dans ${Math.ceil(left / 1000)} s`
        : `retour à l'accueil dans ${Math.ceil(left / 1000)} s (Réglages pour changer le délai)`;
    $("#autohome").classList.toggle("paused", autoHomeBlocked());
    if (left > 0) return;
    cancelAutoHome();
    if (favReturn && isFavPage(state.page)) return backFromFavorites();
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

/**
 * Production + commande de comparaison : la touche est armée 60 s et le diff est tapé (sans Entrée) avec le
 * texte sélectionné ; ce texte est gardé pour la vraie commande du 2e clic (même release, même fichier).
 */
function armDiffKey(key) {
    disarmProdKey(false);
    const terms = [state.terms.get(state.active), ...state.terms.values()].filter(Boolean);
    const t = terms.find((x) => !x.ended && x.term.hasSelection());
    const selected = t ? t.term.getSelection().replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim() : "";
    const diff = withSelection(key.diff);
    if (selected) noteSelection = { text: selected, time: Date.now() };   // repris par le 2e clic
    prodArmed = { id: key.id, timer: setTimeout(() => disarmProdKey(true), 60000) };
    journalAction({ ...key, label: `${key.label} (diff)` }, diff, "type");
    typeInTerminal(diff);
    toast(`PRODUCTION « ${prodContext()} » : comparaison tapée, vérifie-la (Entrée) ; puis reclique sur « ${key.label} » dans la minute pour la vraie commande${/^helm diff/.test(key.diff) ? " (extension helm-diff nécessaire)" : ""}`);
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

/** Nom à afficher pour un terminal connecté : VM de l'inventaire, sinon l'hôte (sans utilisateur), sinon « ssh ». */
function remoteName(sid) {
    const kind = state.remote[sid];
    if (!kind) return null;
    const t = state.remoteTargets[sid];
    if (t?.vm) return t.vm;
    if (t?.dest) return kind === "wsl" ? `wsl ${t.dest}` : t.host || t.dest.replace(/^[^@]*@/, "");
    return kind;
}

/** Badge sur l'onglet des terminaux connectés : nom de la VM (ou de l'hôte), en rouge si c'est de la production. */
function markRemoteTabs() {
    for (const [sid, t] of state.terms) {
        const name = remoteName(sid);
        const target = state.remoteTargets[sid];
        t.tab.classList.toggle("remote", Boolean(name));
        t.tab.classList.toggle("remote-prod", target?.env === "production");
        t.tab.classList.toggle("remote-host", Boolean(target?.dest));
        // Vue partagée : l'étiquette du coin de l'écran donne aussi la machine (« zsh 2 · app-prod-01 »)
        t.screen.dataset.title = name ? `${t.title ?? t.defaultTitle} · ${name}` : t.title ?? t.defaultTitle;
        t.screen.classList.toggle("remote-host", Boolean(name));
        t.screen.classList.toggle("remote-prod", target?.env === "production");
        // Étiquette accrochée au cadre (vue simple) : « SSH · app-prod-01 · production »
        if (name) t.screen.dataset.remoteLabel = `${state.remote[sid] === "wsl" ? "WSL" : "SSH"} · ${name}${target?.env ? ` · ${target.env}` : ""}${target?.via ? " · via bastion" : ""}`;
        else delete t.screen.dataset.remoteLabel;
        if (name) {
            t.tab.dataset.remote = name.length > 22 ? `${name.slice(0, 21)}…` : name;
            t.tab.title = `${state.remote[sid] === "wsl" ? "WSL" : "Connecté en ssh"} : ${target?.host ?? target?.dest ?? "?"}${target?.via ? ` (via le bastion ${target.via})` : ""}${target?.vm ? ` · VM ${target.vm}${target.env ? ` (${target.env})` : ""}` : ""}`;
        } else {
            delete t.tab.dataset.remote;
            t.tab.removeAttribute("title");
        }
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
    const date = u.date ? new Date(u.date).toLocaleDateString(dateLocale()) : "";
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

const BACKUP_LABELS = { "favoris.json": "Favoris", "actions.json": "Mes actions", "settings.json": "Réglages", "patches.json": "Patchs des VMs", "vault.enc": "Coffre (chiffré)" };

function renderBackups(all) {
    $("#backup-rows").replaceChildren(...Object.entries(BACKUP_LABELS).map(([name, label]) => {
        const list = all?.[name] ?? [];
        const row = Object.assign(document.createElement("div"), { className: "backup-row" });
        const select = document.createElement("select");
        if (!list.length) select.append(new Option("aucune copie pour l'instant", ""));
        for (const b of list) select.append(new Option(`${new Date(b.time).toLocaleString(dateLocale())} (${b.size < 1024 ? `${b.size} o` : `${Math.round(b.size / 1024)} Ko`})`, b.id));
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
    $("#mission-certs").value = (m?.certs ?? []).map((c) => (typeof c === "string" ? c : `${c.target} ${c.env}`)).join("\n");
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
        // « hôte[:port] environnement » par ligne ; une URL complète est acceptée (seul l'hôte est gardé)
        certs: $("#mission-certs").value.split(/\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
            const [first, ...rest] = l.split(/[\s;,]+/);
            return { target: first.replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, ""), env: rest.join(" ") };
        }),
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
    const field = /certificat|port invalide|environnement inconnu/i.test(text) ? "#mission-certs" : /variable/i.test(text) ? "#mission-vars" : /dossier/i.test(text) ? "#mission-workspace" : /motif/i.test(text) ? "#mission-prod" : /nom/i.test(text) ? "#mission-name" : null;
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

// ---------- Proxy : mode choisi dans le deck (Réglages › Proxy, bouton de l'en-tête) ----------

const PROXY_MODES = { auto: "Automatique (bureau / maison)", on: "Activé", off: "Désactivé", system: "Système (variables de la session)" };

function applyProxy(p) {
    state.proxy = p;
    const btn = $("#proxy-toggle");
    // Bouton visible dès qu'un proxy est connu (adresse saisie ou variable de la session), ou un mode choisi
    btn.hidden = !(p.configured || p.system?.url || p.mode !== "system");
    btn.classList.toggle("on", p.active);
    $("#proxy-toggle-text").textContent = p.mode === "auto" ? `Proxy auto · ${p.active ? "bureau" : "direct"}` : p.active ? "Proxy actif" : "Sans proxy";
    btn.title = `${p.active ? `Connexions par ${p.url}` : "Connexion directe"} · ${p.label}\nClic : changer de mode`;
    renderProxyState();
}

function renderProxyState() {
    const p = state.proxy;
    const el = $("#proxy-state");
    if (!p || !el) return;
    el.classList.toggle("on", p.active);
    el.textContent = `${p.active ? `● Actif : ${p.url}${p.noProxy ? ` · sans proxy : ${p.noProxy}` : ""}` : "○ Inactif : connexion directe"} · ${p.label}${p.checked ? ` · ${new Date(p.checked).toLocaleTimeString(dateLocale(), { hour: "2-digit", minute: "2-digit" })}` : ""}`;
}

function fillProxySettings() {
    const s = state.settings?.proxy ?? { mode: "system", url: "", noProxy: "" };
    const radio = document.querySelector(`input[name="proxy-mode"][value="${s.mode}"]`);
    if (radio) radio.checked = true;
    $("#set-proxy-url").value = s.url ?? "";
    $("#set-proxy-noproxy").value = s.noProxy ?? "";
    // Valeurs de la session proposées en gris quand rien n'est saisi
    $("#set-proxy-url").placeholder = state.proxy?.system?.url || "http://proxy.client.fr:8080";
    $("#set-proxy-noproxy").placeholder = state.proxy?.system?.noProxy || "localhost,.intra.client.fr";
    renderProxyState();
}

/** Menu du bouton de l'en-tête : changement de mode immédiat (enregistré). */
function openProxyMenu(btn) {
    const p = state.proxy ?? {};
    const items = Object.entries(PROXY_MODES).map(([mode, label]) => ({ label, current: p.mode === mode, title: label, onClick: () => { closePicker(); send({ t: "proxy-set", mode }); } }));
    pickerAnchor = btn;
    $("#picker").classList.remove("certs-panel");
    $("#picker").hidden = false;
    const note = Object.assign(document.createElement("p"), { className: "picker-note", textContent: `${p.active ? `Actif : ${p.url}` : "Connexion directe"} · ${p.label ?? ""}. Adresse et NO_PROXY : Réglages › Proxy.` });
    $("#picker").replaceChildren(pickerSection("Proxy", items, ""), note);
    placePicker();
}

// ---------- Réglages : une section à la fois, menu à gauche ----------

/** Sections regroupées dans le menu (titre de la section = sa légende dans index.html). */
const SETTINGS_GROUPS = [
    ["Personnaliser", ["Apparence", "Navigation", "Rubriques", "Mes actions", "Missions"]],
    ["Traçabilité", ["Journal des actions", "Enregistrements de sessions"]],
    ["Données", ["Favoris", "Coffre", "Sauvegardes", "Configuration complète"]],
    ["Système", ["Proxy", "Serveur"]]
];
let settingsTab = (() => { try { return localStorage.getItem("deck-settings-tab") || "Apparence"; } catch { return "Apparence"; } })();
const settingsSections = () => [...document.querySelectorAll("#settings-pane > fieldset.settings-group")];
// Nom français d'origine (clé des groupes et de l'onglet mémorisé), même quand l'interface est en anglais
const sectionName = (fs) => sourceText(fs.querySelector(":scope > legend")).trim();

function renderSettingsNav() {
    const byName = new Map(settingsSections().map((fs) => [sectionName(fs), fs]));
    const nav = $("#settings-nav");
    nav.replaceChildren();
    const placed = new Set();
    const button = (name) => {
        placed.add(name);
        const b = Object.assign(document.createElement("button"), { type: "button", className: `settings-tab${name === settingsTab ? " on" : ""}`, textContent: name });
        b.setAttribute("aria-current", String(name === settingsTab));
        b.addEventListener("click", () => showSettingsTab(name));
        return b;
    };
    for (const [group, names] of SETTINGS_GROUPS) {
        const present = names.filter((n) => byName.has(n));
        if (!present.length) continue;
        nav.append(Object.assign(document.createElement("span"), { className: "settings-nav-group", textContent: group }), ...present.map(button));
    }
    // Section ajoutée plus tard sans être rangée dans un groupe : en fin de menu plutôt qu'invisible
    const rest = [...byName.keys()].filter((n) => !placed.has(n));
    if (rest.length) nav.append(Object.assign(document.createElement("span"), { className: "settings-nav-group", textContent: "Autres" }), ...rest.map(button));
}

/** Affiche une section (par sa légende), garde le choix pour la prochaine ouverture. */
function showSettingsTab(name) {
    const sections = settingsSections();
    if (!sections.some((fs) => sectionName(fs) === name)) name = sectionName(sections[0]);
    settingsTab = name;
    try { localStorage.setItem("deck-settings-tab", name); } catch { /* stockage indisponible : choix non retenu */ }
    for (const fs of sections) fs.hidden = sectionName(fs) !== name;
    renderSettingsNav();
    $("#settings-pane").scrollTop = 0;
}

// Champ invalide dans une section cachée (ex. délai de retour à l'accueil) : la section s'affiche pour le montrer
$("#settings-form").addEventListener("invalid", (ev) => {
    const fs = ev.target.closest("fieldset.settings-group");
    if (fs?.hidden) showSettingsTab(sectionName(fs));
}, true);

function openSettings() {
    $("#set-autohome").value = state.settings.autoHomeSeconds;
    $("#set-autohome-on").checked = state.settings.autoHomeEnabled !== false;
    toggleAutoHomeRow();
    $("#set-appearance").value = state.settings.appearance ?? "dark";
    $("#set-language").value = state.settings.language ?? "fr";
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
    fillProxySettings();
    send({ t: "backup-list" });
    $("#settings").hidden = false;
    refreshVaultIo();
    // Pas de focus sur un champ : le premier clic doit agir directement (sinon il ne sert qu'à quitter ce champ)
    document.activeElement?.blur();
    showSettingsTab(settingsTab);
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
        $("#config-import-summary").textContent = `${file.name}${data.from ? ` (depuis ${data.from.machine}, ${data.from.platform})` : ""} : ${count(data.favorites)} favori(s), ${(data.actions ?? []).length} rubrique(s) d'actions, ${(data.settings?.missions ?? []).length} mission(s), ${(data.patches ?? []).length} VM(s)${data.signature ? ", signature" : ""}`;
        // Ancien export sans inventaire de patchs : rien à remplacer
        $("#cfg-part-patches").disabled = !Array.isArray(data.patches);
        $("#cfg-part-patches").checked = Array.isArray(data.patches) && data.patches.length > 0;
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
        actions: $("#cfg-part-actions").checked, settings: $("#cfg-part-settings").checked, signature: $("#cfg-part-signature").checked,
        patches: $("#cfg-part-patches").checked
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
        const when = data.exported ? ` exporté le ${new Date(data.exported).toLocaleString(dateLocale())}` : "";
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
    setLang(state.settings.language);   // langue en aperçu : retour à celle enregistrée
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
            Object.assign(document.createElement("span"), { className: "j-time", textContent: new Date(f.time).toLocaleString(dateLocale(), { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) }),
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

// ---------- Alerte certificats (passage à l'orange / au rouge) ----------

/** Message dans le deck et notification du système (si autorisée), une fois par seuil (géré par le serveur). */
function certAlert(alerts) {
    const text = alerts.map((a) => tr(`${a.target} : ${a.days < 0 ? "EXPIRÉ" : `expire dans ${a.days} j`} (${new Date(a.until).toLocaleDateString(dateLocale())})`)).join(" · ");
    const red = alerts.some((a) => a.level === "rouge");
    toast(`${red ? "🔴" : "🟠"} certificat ${red ? "urgent" : "à renouveler"} : ${text}`, red ? "ko" : "ok");
    if ("Notification" in window && Notification.permission === "granted") {
        new Notification(tr(red ? "Deck : certificat urgent" : "Deck : certificat à renouveler"), { body: text, icon: "/img/icon-64.png", tag: "deck-certs" });
    }
}

// ---------- Mode partage d'écran ----------

/**
 * Floute à l'écran ce qui révèle l'infrastructure d'un client (contexte kubectl, mission, notes, secrets, hôtes,
 * listes, réglages) ; le survol d'une zone l'affiche. Le terminal reste visible. Gardé d'une session à l'autre.
 */
function applyShare(on, announce = false) {
    document.body.classList.toggle("share-mode", on);
    $("#share-mode").classList.toggle("on", on);
    $("#share-mode").setAttribute("aria-pressed", String(on));
    $("#share-badge").hidden = !on;
    savePref("deck-share", on ? "1" : "0");
    if (announce) toast(on ? "mode partage d'écran : informations du client floutées (survol pour afficher)" : "mode partage d'écran désactivé", "ok");
}

// ---------- Documentation (docs/, Doc as Code) ----------

/** Ouvre la documentation : sommaire à gauche (liens du sommaire docs/README.md), page à droite. */
/** Dossier de la documentation dans la langue de l'interface (docs/en/ en anglais). */
const docsBase = () => (currentLang() === "en" ? "/docs/en/" : "/docs/");

async function openDocs(page = "README.md") {
    $("#docs").hidden = false;
    // Sommaire reconstruit si la langue a changé depuis la dernière ouverture
    if ($("#docs-nav").dataset.base !== docsBase()) {
        $("#docs-nav").replaceChildren();
        $("#docs-nav").dataset.base = docsBase();
        try {
            const summary = await (await fetch(`${docsBase()}README.md`)).text();
            const home = currentLang() === "en" ? "Documentation home" : "Accueil de la documentation";
            const links = [["README.md", home], ...[...summary.matchAll(/^\d+\.\s+\[([^\]]+)\]\(([\w-]+\.md)\)/gm)].map((m) => [m[2], m[1]])];
            $("#docs-nav").replaceChildren(...links.map(([file, label]) => {
                const a = Object.assign(document.createElement("a"), { href: "#", textContent: label });
                a.dataset.doc = file;
                return a;
            }));
        } catch { /* sommaire indisponible : la page s'affiche quand même */ }
    }
    showDoc(page);
}

async function showDoc(page) {
    const box = $("#docs-content");
    try {
        const res = await fetch(`${docsBase()}${page}`);
        if (!res.ok) throw new Error(`page introuvable : ${page}`);
        const md = await res.text();
        box.innerHTML = toHtml(md, { docs: true });   // texte échappé par markdown.js ; images et liens limités à docs/
        $("#docs-title").textContent = /^#\s+(.+)$/m.exec(md)?.[1] ?? "Documentation";
    } catch (err) {
        box.textContent = err.message;
    }
    box.scrollTop = 0;
    for (const a of $("#docs-nav").querySelectorAll("a")) a.classList.toggle("on", a.dataset.doc === page);
}

// ---------- Patchs des VMs (rubrique Patchs) ----------

let patchEditing = null;   // VM en cours de modification (null = nouvelle)
// Filtres : environnement, tags combinés, état ; « pick » = sélection venue du tableau de bord ({ label, names })
const patchFilter = { env: null, tags: new Set(), state: null, pick: null };

/** États filtrables d'une VM (urgence du patch, résultat de la dernière vérification). */
const live = (pred) => (v) => !v.decommissioned && pred(v);   // VM suivie (hors décommissionnées)
const PATCH_STATES = [
    ["late", "🔴 en retard ou J-1", live((v) => patchDays(v) !== null && patchDays(v) <= 1)],
    ["soon", "🟠 sous 7 j, à planifier ou sécurité", live((v) => vmLevel(v) === "orange")],
    ["ok", "🟢 plus tard", live((v) => vmLevel(v) === "ok")],
    ["decom", "⚫ décommissionnée", (v) => v.decommissioned === true]
];

/** Tris de l'inventaire : clé -> [libellé, comparaison croissante]. Choix retenu (localStorage). */
const ENV_ORDER = ["production", "qualification", "recette", "développement", "autre"];
const PATCH_SORTS = {
    urgency: ["Urgence (prochain patch)", (a, b) => (patchDays(a) ?? -1e6) - (patchDays(b) ?? -1e6)],
    name: ["Nom", (a, b) => a.name.localeCompare(b.name, "fr", { numeric: true })],
    env: ["Environnement", (a, b) => ENV_ORDER.indexOf(a.env) - ENV_ORDER.indexOf(b.env) || a.name.localeCompare(b.name, "fr", { numeric: true })],
    last: ["Dernier patch", (a, b) => (a.lastPatch || "0").localeCompare(b.lastPatch || "0")],
    next: ["Prochain patch", (a, b) => (a.nextPatch || "9").localeCompare(b.nextPatch || "9")]
};
const patchSort = (() => {
    try { const s = JSON.parse(localStorage.getItem("deck-patch-sort")); if (PATCH_SORTS[s?.key]) return { key: s.key, desc: Boolean(s.desc) }; } catch { /* stockage indisponible */ }
    return { key: "urgency", desc: false };
})();
function setPatchSort(key, desc) {
    patchSort.key = key;
    patchSort.desc = desc;
    try { localStorage.setItem("deck-patch-sort", JSON.stringify(patchSort)); } catch { /* choix non retenu */ }
    renderPatches();
}
let patchPending = false;  // formulaire envoyé, en attente du serveur

/** Regroupement de l'inventaire par cluster (retenu dans le navigateur). */
let patchGroupByCluster = (() => { try { return localStorage.getItem("deck-patch-group") === "cluster"; } catch { return false; } })();

/** Cluster et profil d'une VM, sous son nom. */
function patchClusterLine(vm) {
    if (!vm.cluster && !vm.profile) return "";
    const div = Object.assign(document.createElement("div"), { className: "patch-cluster-line" });
    if (vm.cluster) div.append(Object.assign(document.createElement("span"), { className: "patch-cluster", textContent: `⬡ ${vm.cluster}`, title: `Cluster ${vm.cluster}${vm.clusterSet ? ` · ClusterSet ${vm.clusterSet}` : ""}` }));
    if (vm.profile === "mysql-innodb") div.append(Object.assign(document.createElement("span"), { className: "patch-profile", textContent: "MySQL InnoDB", title: "Profil MySQL InnoDB Cluster" }));
    return div;
}

// ---------- Tableau de bord des patchs (VMs, environnements, clusters, échéances) ----------

/** Statuts du patch : couleur réservée + icône + libellé (jamais la couleur seule). */
const DASH_STATUS = [
    ["late", "🔴", "en retard ou J-1", "#d03b3b"],
    ["soon", "🟠", "sous 7 j ou sécurité", "#fab219"],
    ["todo", "◌", "à planifier", "#ec835a"],
    ["ok", "🟢", "à jour", "#0ca30c"]
];
// Sécurité en attente (relevé) avec une date lointaine : compte avec « sous 7 j » (orange)
const dashStatus = (v) => { const d = patchDays(v); return d === null ? "todo" : d <= 1 ? "late" : d <= 7 || securityPending(v) ? "soon" : "ok"; };

function openPatchDash() {
    $("#patches").hidden = true;
    $("#patch-dash").hidden = false;
    send({ t: "patch-list" });
    renderPatchDash();
}

/** Élément HTML court. */
const h = (tag, cls, text, attrs = {}) => Object.assign(document.createElement(tag), { className: cls, ...(text != null ? { textContent: text } : {}), ...attrs });

/** Ouvre l'inventaire sur les VMs d'un élément du tableau de bord (filtre « Sélection », retiré d'un clic). */
function dashDrill(names, label) {
    patchFilter.env = null;
    patchFilter.tags.clear();
    patchFilter.state = null;
    patchFilter.pick = { label, names: new Set(names) };
    $("#patch-search").value = "";
    $("#patch-dash").hidden = true;
    openPatches();
}

/** Élément du tableau de bord cliquable (souris, Entrée ou Espace) : inventaire filtré sur ses VMs. */
function drillable(el, names, label) {
    if (!names.length) return el;
    el.classList.add("dash-click");
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    if (el.dataset.tip) el.dataset.tip += "\nClic : voir dans l'inventaire";
    else el.title = "Clic : voir dans l'inventaire";
    const go = (ev) => { ev.stopPropagation(); dashDrill(names, label); };
    el.addEventListener("click", go);
    el.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); go(ev); } });
    return el;
}

function renderPatchDash() {
    if ($("#patch-dash").hidden) return;
    const all = state.patches ?? [];
    const vms = all.filter((v) => !v.decommissioned);
    const decom = all.length - vms.length;
    const count = (pred, list = vms) => list.filter(pred).length;
    const byStatus = Object.fromEntries(DASH_STATUS.map(([k]) => [k, count((v) => dashStatus(v) === k)]));
    const clusters = [...new Set(all.map((v) => v.cluster).filter(Boolean))].sort();
    const vipCount = clusters.reduce((n, c) => n + (state.patchClusters?.[c]?.vips?.length ?? 0), 0);
    const noPrimary = clusters.filter((c) => { const nodes = vms.filter((v) => v.cluster === c); return nodes.length && !nodes.some((v) => v.role === "primary"); });
    $("#dash-asof").textContent = `${vms.length} VM(s) suivie(s) · mis à jour à ${new Date().toLocaleTimeString(dateLocale(), { hour: "2-digit", minute: "2-digit" })}`;
    if (!all.length) {
        $("#dash-body").replaceChildren(h("p", "hint", "Aucune VM dans l'inventaire : « + VM » ou « Importer… » dans l'inventaire des patchs."));
        return;
    }

    // 1. Tuiles : les chiffres qui comptent
    const tile = (label, value, sub, cls = "") => { const t = h("div", `dash-tile ${cls}`); t.append(h("span", "dash-tile-label", label), h("span", "dash-tile-value", String(value)), h("span", "dash-tile-sub", sub)); return t; };
    const tiles = h("section", "dash-tiles");
    const names = (list) => list.map((v) => v.name);
    tiles.append(
        drillable(tile("VMs suivies", vms.length, `${count((v) => v.env === "production")} en production`), names(vms), tr("VMs suivies")),
        drillable(tile("En retard ou J-1", byStatus.late, byStatus.late ? "🔴 à patcher maintenant" : "🟢 aucune", byStatus.late ? "critical" : ""), names(vms.filter((v) => dashStatus(v) === "late")), tr("En retard ou J-1")),
        drillable(tile("Sous 7 j ou sécurité", byStatus.soon, byStatus.todo ? `◌ ${byStatus.todo} sans date` : "toutes planifiées", byStatus.soon ? "warning" : ""), names(vms.filter((v) => ["soon", "todo"].includes(dashStatus(v)))), tr("Sous 7 j ou sécurité")),
        drillable(tile("Clusters", clusters.length, noPrimary.length ? `★ ${noPrimary.length} sans PRIMARY` : `${count((v) => v.cluster)} nœuds`), names(vms.filter((v) => v.cluster)), tr("Clusters")),
        drillable(tile("VIP", vipCount, `${clusters.filter((c) => state.patchClusters?.[c]?.vips?.length).length} cluster(s) équipé(s)`), names(vms.filter((v) => state.patchClusters?.[v.cluster]?.vips?.length)), tr("VIP")),
        drillable(tile("Décommissionnées", decom, "hors suivi"), names(all.filter((v) => v.decommissioned)), tr("Décommissionnées"))
    );

    // 2. Patch par environnement : barres empilées par statut (légende + étiquettes + infobulle)
    const envs = [...new Set(vms.map((v) => v.env))].sort((a, b) => (a === "production" ? -1 : b === "production" ? 1 : a.localeCompare(b)));
    const legend = h("div", "dash-legend");
    for (const [, , label, color] of DASH_STATUS) { const i = h("span", "dash-legend-item"); i.append(h("i", "dash-swatch", null, { style: `background:${color}` }), label); legend.append(i); }
    const maxEnv = Math.max(...envs.map((e) => count((v) => v.env === e)), 1);
    const envRows = h("div", "dash-rows");
    for (const env of envs) {
        const list = vms.filter((v) => v.env === env);
        const row = h("div", "dash-row");
        const bar = h("div", "dash-stack", null, { style: `width:${Math.max(8, (list.length / maxEnv) * 100)}%` });
        for (const [k, icon, label, color] of DASH_STATUS) {
            const n = list.filter((v) => dashStatus(v) === k).length;
            if (!n) continue;
            const seg = h("span", "dash-seg", n / list.length >= 0.12 ? String(n) : "", { style: `flex:${n};background:${color};color:${k === "soon" ? "#0b0b0b" : "#fff"}` });
            seg.dataset.tip = `${env} · ${icon} ${label} : ${n} VM(s)\n${list.filter((v) => dashStatus(v) === k).map((v) => v.name).slice(0, 8).join(", ")}${n > 8 ? "…" : ""}`;
            bar.append(drillable(seg, names(list.filter((v) => dashStatus(v) === k)), `${tr(env)} · ${tr(label)}`));
        }
        row.append(drillable(h("span", "dash-row-label", env), names(list), tr(env)), h("div", "dash-row-track", null), h("span", "dash-row-value", String(list.length)));
        row.children[1].append(bar);
        envRows.append(row);
    }
    const envTable = dashTable(["Environnement", ...DASH_STATUS.map(([, i, l]) => `${i} ${l}`), "Total"],
        envs.map((e) => { const l = vms.filter((v) => v.env === e); return [e, ...DASH_STATUS.map(([k]) => l.filter((v) => dashStatus(v) === k).length), l.length]; }));

    // 3. Prochains patchs : VMs par semaine sur 8 semaines (une teinte)
    const weeks = Array.from({ length: 8 }, (_, i) => ({ i, list: vms.filter((v) => { const d = patchDays(v); return d !== null && d >= i * 7 && d < (i + 1) * 7; }) }));
    const maxWeek = Math.max(...weeks.map((w) => w.list.length), 1);
    const cols = h("div", "dash-cols");
    for (const w of weeks) {
        const start = new Date(Date.now() + w.i * 7 * 86400000);
        const col = h("div", "dash-col");
        const fill = h("span", "dash-col-bar", null, { style: `height:${w.list.length ? Math.max(4, (w.list.length / maxWeek) * 100) : 0}%` });
        col.dataset.tip = `${w.i === 0 ? "Cette semaine" : `Semaine du ${start.toLocaleDateString(dateLocale(), { day: "2-digit", month: "2-digit" })}`} : ${w.list.length} patch(s)${w.list.length ? `\n${w.list.map((v) => v.name).slice(0, 10).join(", ")}${w.list.length > 10 ? "…" : ""}` : ""}`;
        col.append(h("span", "dash-col-value", w.list.length ? String(w.list.length) : ""), h("div", "dash-col-track"), h("span", "dash-col-label", w.i === 0 ? "cette sem." : start.toLocaleDateString(dateLocale(), { day: "2-digit", month: "2-digit" })));
        col.children[1].append(fill);
        cols.append(drillable(col, names(w.list), w.i === 0 ? tr("Cette semaine") : tr(`Semaine du ${start.toLocaleDateString(dateLocale(), { day: "2-digit", month: "2-digit" })}`)));
    }

    // 4. Clusters : état, PRIMARY, nœuds, VIP
    const clusterRows = clusters.map((c) => {
        const nodes = all.filter((v) => v.cluster === c);
        const live = nodes.filter((v) => !v.decommissioned);
        const worst = !live.length ? "decom" : live.some((v) => dashStatus(v) === "late") ? "late" : live.some((v) => dashStatus(v) === "soon") ? "soon" : live.some((v) => dashStatus(v) === "todo") ? "todo" : "ok";
        const st = DASH_STATUS.find(([k]) => k === worst);
        const row = h("div", `dash-cluster ${worst === "decom" ? "decom" : ""}`);
        const pills = h("span", "dash-cluster-nodes");
        for (const v of nodes) {
            const s = DASH_STATUS.find(([k]) => k === dashStatus(v));
            const p = h("i", `dash-node ${v.decommissioned ? "decom" : ""} ${v.role === "primary" ? "primary" : ""}`, null, { style: v.decommissioned ? "" : `background:${s[3]}` });
            p.dataset.tip = `${v.name}${v.role ? ` · ${v.role.toUpperCase()}` : ""} · ${v.decommissioned ? "décommissionnée" : `${s[1]} ${s[2]}`}`;
            pills.append(p);
        }
        row.append(
            h("span", "dash-cluster-name", `⬡ ${c}`),
            h("span", `patch-env env-${live[0]?.env ?? nodes[0].env}`, live[0]?.env ?? nodes[0].env),
            pills,
            h("span", "dash-cluster-meta", `${live.length} nœud(s)${nodes.length > live.length ? ` +${nodes.length - live.length} décom.` : ""}`),
            h("span", "dash-cluster-meta", live.find((v) => v.role === "primary") ? `★ ${live.find((v) => v.role === "primary").name}` : live.length ? "★ PRIMARY ?" : ""),
            h("span", "dash-cluster-meta", `${state.patchClusters?.[c]?.vips?.length ?? 0} VIP`),
            h("span", "dash-cluster-state", worst === "decom" ? "⚫ décom." : `${st[1]} ${{ late: "en retard", soon: "sous 7 j", todo: "à planifier", ok: "à jour" }[worst]}`, { title: worst === "decom" ? "cluster décommissionné" : st[2] })
        );
        return drillable(row, names(nodes), `⬡ ${c}`);
    });

    // 5. Tags les plus fréquents (classement, une teinte)
    const tagCounts = {};
    for (const v of vms) for (const t of v.tags ?? []) tagCounts[t] = (tagCounts[t] ?? 0) + 1;
    const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8);
    const maxTag = Math.max(...topTags.map(([, n]) => n), 1);
    const tags = h("div", "dash-rows");
    for (const [t, n] of topTags) {
        const row = h("div", "dash-row");
        const bar = h("span", "dash-hbar", null, { style: `width:${Math.max(3, (n / maxTag) * 100)}%` });
        bar.dataset.tip = `#${t} : ${n} VM(s)`;
        row.append(h("span", "dash-row-label", `#${t}`), h("div", "dash-row-track"), h("span", "dash-row-value", String(n)));
        row.children[1].append(bar);
        tags.append(drillable(row, names(vms.filter((v) => (v.tags ?? []).includes(t))), `#${t}`));
    }

    const card = (title, ...content) => { const c = h("section", "dash-card"); c.append(h("h3", "", title), ...content); return c; };

    // Anneaux : état du parc, environnements, état des clusters (répartition d'un tout, d'un coup d'œil)
    const okCount = byStatus.ok;
    const statusDonut = dashDonut("État du parc", `${vms.length ? Math.round((okCount / vms.length) * 100) : 0} %`, "à jour",
        DASH_STATUS.map(([k, , label, color]) => ({ label, value: byStatus[k], color, names: names(vms.filter((v) => dashStatus(v) === k)) })));
    const otherEnvs = [...new Set(vms.map((v) => v.env))].filter((e) => !DASH_ENVS.includes(e));
    const envDonut = dashDonut("VMs par environnement", vms.length, "VMs suivies",
        [...DASH_ENVS, ...otherEnvs].map((e) => ({ label: e, value: count((v) => v.env === e), color: `var(--env-${DASH_ENVS.includes(e) ? DASH_ENVS.indexOf(e) : 4})`, names: names(vms.filter((v) => v.env === e)) })));
    const clusterState = (c) => {
        const live = all.filter((v) => v.cluster === c && !v.decommissioned);
        return !live.length ? "decom" : ["late", "soon", "todo", "ok"].find((k) => live.some((v) => dashStatus(v) === k));
    };
    const clusterDonut = dashDonut("État des clusters", clusters.length, "clusters",
        [...DASH_STATUS.map(([k, , label, color]) => [k, label, color]), ["decom", "décommissionné", "#78909c"]].map(([k, label, color]) => {
            const list = clusters.filter((c) => clusterState(c) === k);
            return { label, value: list.length, color, names: names(all.filter((v) => list.includes(v.cluster))) };
        }), "Clusters");
    const donuts = h("div", "dash-donuts");
    donuts.append(statusDonut, envDonut, ...(clusters.length ? [clusterDonut] : []));

    // 6. Points de vigilance : ce qui peut mal tourner pendant la campagne (clic : VMs concernées)
    const risks = patchRisks(all, state.patchClusters ?? {});
    const RISK_ICON = { critical: "🔴", warning: "🟠", info: "ℹ" };
    const riskList = h("div", "dash-risks");
    for (const r of risks) {
        // Une ligne par type : titre, nombre de clusters (ou VMs) concernés, les premiers en clair, tous au survol
        const row = h("div", `dash-risk ${r.level}`);
        const body = h("span", "dash-risk-body");
        const items = h("span", "dash-risk-items", `${r.items.slice(0, 4).join(" · ")}${r.items.length > 4 ? ` +${r.items.length - 4}` : ""}`);
        items.dataset.noI18n = "";
        body.append(h("span", "dash-risk-text", r.text), h("span", "dash-risk-count", `${r.items.length} ${r.unit}`), items);
        row.append(h("span", "dash-risk-icon", RISK_ICON[r.level]), body);
        row.dataset.tip = r.items.join("\n");
        riskList.append(drillable(row, r.vms, `⚠ ${tr(r.text)}`));
    }
    const riskCard = card(`Points de vigilance (${risks.length})`, risks.length ? riskList : h("p", "hint", "🟢 Rien à signaler : un nœud à la fois, PRIMARY en dernier, recette avant production."));

    // 7. Ordre de patch proposé : 7 prochains jours et retard, cluster par cluster
    const plan = patchPlan(all);
    const planBox = h("div", "dash-plan");
    plan.forEach((g, i) => {
        const group = h("div", `dash-plan-group env-${g.env}`);
        const title = h("span", "dash-plan-name", g.cluster ? `⬡ ${g.cluster}` : g.vms[0]);
        title.dataset.noI18n = "";
        const head = h("div", "dash-plan-head");
        head.append(h("span", "dash-plan-num", String(i + 1)), title, h("span", `patch-env env-${g.env}`, g.env), h("span", "dash-plan-when", patchLabel(g.urgency)));
        group.append(drillable(head, g.vms, g.cluster ? `⬡ ${g.cluster}` : g.vms[0]));
        if (g.warning) group.append(h("p", "dash-plan-warn", g.warning));
        const ol = h("ol", "dash-plan-steps");
        for (const st of g.steps) {
            const li = h("li", st.kind === "switch" ? "switch" : st.due ? "" : "early");
            if (st.kind === "switch") li.append(h("span", "", `↻ Basculer le PRIMARY de ${st.from} vers ${st.to} (touche « changer PRIMARY »)`));
            else {
                const name = h("strong", "", st.vm);
                name.dataset.noI18n = "";
                li.append(name);
                if (st.role) li.append(h("span", `patch-role role-${st.role}`, st.role === "primary" ? "★ PRIMARY" : "SECONDARY"));
                if (st.note) li.append(h("span", "dash-plan-note", st.note));
                li.append(h("span", "dash-plan-when", st.due ? patchLabel(st.days) : `pas encore dû · ${patchLabel(st.days)}`));
                if (st.security) li.append(h("span", "patch-badge sec", `🛡 ${st.security} sécurité`));
            }
            ol.append(li);
        }
        group.append(ol);
        if (g.cluster) group.append(h("p", "hint", "Entre deux nœuds : cluster status, tous les membres ONLINE avant le suivant."));
        planBox.append(group);
    });
    const copyPlan = h("button", "dash-copy", "Copier le plan (Markdown)", { type: "button", title: "Pour une demande de changement, un mail ou un ticket (texte en français)" });
    copyPlan.addEventListener("click", () => navigator.clipboard.writeText(planMarkdown(plan)).then(() => toast("plan copié (Markdown)", "ok"), () => toast("copie refusée par le navigateur")));
    const planCard = card("Ordre de patch proposé · 7 jours et retard", ...(plan.length ? [planBox, copyPlan] : [h("p", "hint", "Rien à patcher dans les 7 prochains jours.")]));
    const top = h("div", "dash-grid");
    top.append(riskCard, planCard);

    const grid = h("div", "dash-grid");
    grid.append(
        card("Patch par environnement", legend, envRows, envTable),
        card("Prochains patchs · 8 semaines", cols, h("p", "hint", byStatus.late ? `+ ${byStatus.late} VM(s) déjà en retard ou à J-1, ${byStatus.todo} sans date` : `${byStatus.todo} VM(s) sans date de patch`)),
        card(`Clusters (${clusters.length})`, ...(clusterRows.length ? clusterRows : [h("p", "hint", "Aucun cluster : renseigne le champ Cluster de tes VMs.")])),
        card("Tags les plus fréquents", ...(topTags.length ? [tags] : [h("p", "hint", "Aucun tag.")]))
    );
    $("#dash-body").replaceChildren(tiles, donuts, top, grid);
}

/** Environnements dans l'anneau : ordre fixe (la couleur suit l'environnement, jamais son rang), teintes non réservées. */
// Ordre de l'anneau et couleurs (style.css, --env-N) choisis pour que deux parts voisines restent distinctes, daltonisme
// compris : production bleu, recette orange, qualification violet, développement aqua, autre gris
const DASH_ENVS = ["production", "recette", "qualification", "développement", "autre"];

/**
 * Anneau (camembert évidé) : un tout en 6 parts au plus, lu d'un coup d'œil. Parts séparées par un liseré, nombre
 * imprimé sur les parts assez grandes, chiffre clé au centre, légende avec nombre et pourcentage, détail au survol,
 * clic (ou Entrée) vers l'inventaire filtré, vue tableau. parts : [{ label, value, color, names }].
 */
function dashDonut(title, center, centerLabel, parts, unit = "VMs") {
    const NS = "http://www.w3.org/2000/svg";
    const R = 52, W = 20, C = 2 * Math.PI * R;
    const total = parts.reduce((n, p) => n + p.value, 0);
    const shown = parts.filter((p) => p.value);
    const pct = (v) => (total ? Math.round((v / total) * 100) : 0);
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 140 140");
    svg.setAttribute("class", "dash-donut-svg");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `${tr(title)} : ${shown.map((p) => `${tr(p.label)} ${p.value}`).join(", ")}`);
    const ring = (attrs) => { const c = document.createElementNS(NS, "circle"); for (const [k, v] of Object.entries({ cx: 70, cy: 70, r: R, fill: "none", "stroke-width": W, ...attrs })) c.setAttribute(k, v); return c; };
    svg.append(ring({ class: "dash-donut-track" }));
    const gap = shown.length > 1 ? 2.5 : 0;   // liseré de la couleur du fond entre deux parts
    let offset = 0;
    for (const p of shown) {
        const len = (p.value / total) * C;
        const slice = ring({ class: "dash-donut-slice", style: `stroke:${p.color}`, "stroke-dasharray": `${Math.max(len - gap, 0.6)} ${C}`, "stroke-dashoffset": `${-offset}`, transform: "rotate(-90 70 70)" });
        slice.dataset.tip = `${tr(p.label)} : ${p.value} · ${pct(p.value)} %${p.names.length ? `\n${p.names.slice(0, 8).join(", ")}${p.names.length > 8 ? "…" : ""}` : ""}`;
        svg.append(drillable(slice, p.names, tr(p.label)));
        // Nombre sur la part si elle est assez grande (au moins 9 %)
        if (p.value / total >= 0.09) {
            const mid = ((offset + len / 2) / C) * 2 * Math.PI - Math.PI / 2;
            const t = document.createElementNS(NS, "text");
            for (const [k, v] of Object.entries({ x: 70 + R * Math.cos(mid), y: 70 + R * Math.sin(mid), class: "dash-donut-num" })) t.setAttribute(k, v);
            t.textContent = String(p.value);
            svg.append(t);
        }
        offset += len;
    }
    const chart = h("div", "dash-donut-chart");
    const mid = h("div", "dash-donut-center");
    mid.append(h("span", "dash-donut-value", String(center)), h("span", "dash-donut-label", centerLabel));
    chart.append(svg, mid);
    const legend = h("div", "dash-donut-legend");
    for (const p of parts) {
        if (!p.value) continue;
        const row = h("div", "dash-donut-item");
        row.append(h("i", "dash-swatch", null, { style: `background:${p.color}` }), h("span", "dash-donut-name", p.label), h("span", "dash-donut-count", String(p.value)), h("span", "dash-donut-pct", `${pct(p.value)} %`));
        legend.append(drillable(row, p.names, tr(p.label)));
    }
    const body = h("div", "dash-donut");
    body.append(chart, legend);
    const c = h("section", "dash-card dash-donut-card");
    c.append(h("h3", "", title), body, dashTable(["", unit, "%"], parts.filter((p) => p.value).map((p) => [p.label, p.value, `${pct(p.value)} %`])));
    return c;
}

/** Vue tableau d'un graphique (accessibilité, copie), repliée par défaut. */
function dashTable(head, rows) {
    const d = h("details", "dash-table");
    const t = h("table", "patch-table");
    const tr = h("tr", "");
    for (const c of head) tr.append(h("th", "", c));
    const thead = h("thead", ""); thead.append(tr);
    const tbody = h("tbody", "");
    for (const r of rows) { const row = h("tr", ""); for (const c of r) row.append(h("td", "", String(c))); tbody.append(row); }
    t.append(thead, tbody);
    d.append(h("summary", "", "Voir en tableau"), t);
    return d;
}

/** Cluster dont les VIP sont en cours de modification (formulaire « ✎ VIP »). */
let patchVipEditing = null;

function openVipForm(cluster) {
    patchVipEditing = cluster;
    $("#patch-form").hidden = true;
    $("#patch-vip-title").textContent = `VIP du cluster ${cluster}`;
    $("#patch-vip-list").value = (state.patchClusters?.[cluster]?.vips ?? []).map((v) => `${v.address}${v.port ? `:${v.port}` : ""}${v.label ? ` ${v.label}` : ""}`).join("\n");
    $("#patch-vip-error").hidden = true;
    $("#patch-vip-form").hidden = false;
    $("#patch-vip-form").scrollIntoView({ block: "nearest" });
    $("#patch-vip-list").focus();
}

/** Clusters repliés (en-tête seul), retenus dans le navigateur. */
const patchFolded = (() => { try { return new Set(JSON.parse(localStorage.getItem("deck-patch-folded") ?? "[]")); } catch { return new Set(); } })();

/** Environnement d'un cluster (celui de la majorité de ses nœuds) : couleur du bloc. */
function clusterEnv(cluster, all) {
    const counts = {};
    for (const v of all) if (v.cluster === cluster) counts[v.env] = (counts[v.env] ?? 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

/** Niveau d'urgence du patch d'une VM (comme sur sa ligne). */
/** Mises à jour de sécurité en attente d'après le dernier relevé fait sur la VM. */
const securityPending = (v) => !v.decommissioned && (v.check?.security ?? 0) > 0;
/** Niveau d'une VM (même règle que le serveur) : rouge à J-1 ou en retard ; orange à 7 j, à planifier ou sécurité en attente. */
const vmLevel = (v) => { const d = patchDays(v); return d === null ? "orange" : d <= 1 ? "rouge" : d <= 7 || securityPending(v) ? "orange" : "ok"; };

/**
 * En-tête d'un cluster (mode regroupé) : nom, environnement, ClusterSet, profil ; carte des nœuds (pastille par nœud
 * selon son état, ↻ reboot requis, ⚠ sécurité en attente) ; état le plus urgent ; clic = replier / déplier.
 */
function patchClusterHeader(cluster, nodes, all, folded = false) {
    const members = all.filter((v) => v.cluster === cluster);
    const dead = cluster && members.length && members.every((v) => v.decommissioned);
    const env = !cluster ? "" : dead ? "decom" : clusterEnv(cluster, all.filter((v) => !v.decommissioned));
    const tr = Object.assign(document.createElement("tr"), { className: `patch-group grp-${cluster ? env || "autre" : "none"}${folded ? " folded" : ""}` });
    const td = Object.assign(document.createElement("td"), { colSpan: 6 });
    const el = (cls, text, title) => Object.assign(document.createElement("span"), { className: cls, textContent: text, ...(title ? { title } : {}) });
    if (!cluster) {
        td.append(el("patch-group-name none", "Sans cluster"), el("patch-group-meta", `${nodes.length} VM(s)`));
        tr.append(td);
        return tr;
    }
    const total = members;
    const sets = [...new Set(total.map((v) => v.clusterSet).filter(Boolean))];
    // État du cluster : nœuds suivis seulement (les décommissionnés ne comptent plus)
    const levels = total.filter((v) => !v.decommissioned).map(vmLevel);
    const worst = dead ? "decom" : levels.includes("rouge") ? "rouge" : levels.includes("orange") ? "orange" : "ok";
    const gone = total.filter((v) => v.decommissioned).length;
    const top = Object.assign(document.createElement("div"), { className: "patch-group-top" });
    top.append(
        el("patch-group-fold", folded ? "▸" : "▾"),
        el("patch-group-icon", "⬡"),
        el("patch-group-name", cluster),
        ...[...new Set(total.map((v) => v.env))].map((e) => el(`patch-env env-${e}`, e)),
        ...(sets.length ? [el("patch-group-meta", `ClusterSet ${sets.join(", ")}`)] : []),
        ...(total.some((v) => v.profile === "mysql-innodb") ? [el("patch-profile", "MySQL InnoDB")] : []),
        (() => {
            if (dead) return "";   // cluster décommissionné : plus de PRIMARY à signaler
            const primary = total.find((v) => v.role === "primary");
            return primary ? el("patch-group-primary", `★ PRIMARY : ${primary.name}`, "Nœud PRIMARY renseigné dans l'inventaire (à mettre à jour après une bascule)")
                : el("patch-group-primary none", "PRIMARY non renseigné", "Modifier un nœud › Rôle dans le cluster : PRIMARY");
        })(),
        el("grow", ""),
        el(`patch-group-state lvl-${worst}`, worst === "decom" ? "⚫ cluster décommissionné" : worst === "rouge" ? "patch en retard ou imminent" : worst === "orange" ? "patch sous 7 j" : "à jour")
    );
    // Carte des nœuds : un coup d'œil sur tout le cluster, même replié
    const map = Object.assign(document.createElement("div"), { className: "patch-group-nodes" });
    for (const v of [...total].sort((a, b) => (b.role === "primary") - (a.role === "primary") || a.name.localeCompare(b.name, "fr", { numeric: true }))) {
        const d = patchDays(v);
        const pill = el(`patch-node-pill lvl-${v.decommissioned ? "decom" : vmLevel(v)}${nodes.includes(v) ? "" : " hidden-by-filter"}`, "",
            `${v.name} · ${v.env} · prochain patch ${frDate(v.nextPatch)} (${patchLabel(d)})`);
        pill.append(el("patch-node-dot", v.decommissioned ? "⚫" : "●"), ` ${v.role === "primary" ? "★ " : ""}${v.name}`);
        if (v.decommissioned) pill.title = `décommissionnée${v.decommissionedAt ? ` le ${frDate(v.decommissionedAt)}` : ""} · ${pill.title}`;
        if (v.role === "primary") { pill.classList.add("primary"); pill.title = `PRIMARY · ${pill.title}`; }
        else if (v.role === "secondary") pill.title = `SECONDARY · ${pill.title}`;
        map.append(pill);
    }
    map.append(el("patch-group-meta", `${total.length} nœud(s)${gone ? ` dont ${gone} décommissionné(s)` : ""}${nodes.length < total.length ? ` · ${nodes.length} affiché(s)` : ""}`));
    // VIP du cluster : étiquettes (clic : test de connectivité tapé dans le terminal) et « ✎ VIP »
    const vips = state.patchClusters?.[cluster]?.vips ?? [];
    const vipLine = Object.assign(document.createElement("div"), { className: "patch-group-vips" });
    vipLine.append(el("patch-group-meta", vips.length ? "VIP" : "Aucune VIP"));
    for (const v of vips) {
        const chip = Object.assign(document.createElement("button"), { type: "button", className: "patch-vip",
            textContent: `${v.address}${v.port ? `:${v.port}` : ""}${v.label ? ` · ${v.label}` : ""}`,
            title: v.port ? `Tape « nc -zv ${v.address} ${v.port} » dans le terminal (sans Entrée) : test de connectivité` : `Tape « nc -zv ${v.address} » dans le terminal (port à compléter)` });
        chip.addEventListener("click", (ev) => {
            ev.stopPropagation();
            $("#patches").hidden = true;
            typeInTerminal(`nc -zv ${v.address} ${v.port ?? ""}`.trimEnd() + (v.port ? "" : " "));
        });
        vipLine.append(chip);
    }
    const edit = Object.assign(document.createElement("button"), { type: "button", className: "patch-vip-edit", textContent: "✎ VIP", title: "Ajouter, modifier ou retirer les VIP du cluster" });
    edit.addEventListener("click", (ev) => { ev.stopPropagation(); openVipForm(cluster); });
    vipLine.append(edit);
    td.append(top, map, vipLine);
    td.title = folded ? "Clic : déplier le cluster" : "Clic : replier le cluster (en-tête seul)";
    tr.addEventListener("click", () => {
        if (patchFolded.has(cluster)) patchFolded.delete(cluster); else patchFolded.add(cluster);
        try { localStorage.setItem("deck-patch-folded", JSON.stringify([...patchFolded])); } catch { /* choix non retenu */ }
        renderPatches();
    });
    tr.append(td);
    return tr;
}

const frDate = (d) => (d ? d.split("-").reverse().join("/") : "—");
const patchDays = (vm) => {
    if (!vm.nextPatch) return null;
    const now = new Date();
    const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((Date.parse(`${vm.nextPatch}T00:00:00Z`) - today) / 86400000);
};
/** Résumé d'un relevé : « 12 MAJ dont 3 de sécurité · redémarrage requis » (nombres inconnus : non affichés). */
function surveyText(c) {
    const parts = [];
    if (c.pending !== null) parts.push(c.pending ? `${c.pending} MAJ dont ${c.security ?? "?"} de sécurité` : "aucune MAJ en attente");
    else if (c.security) parts.push(`${c.security} MAJ de sécurité`);
    if (c.reboot) parts.push("redémarrage requis");
    return parts.join(" · ") || "relevé fait";
}

/** Badges d'une VM d'après son dernier relevé : sécurité, mises à jour, redémarrage, date du relevé. */
function surveyBadges(c) {
    const box = Object.assign(document.createElement("div"), { className: "patch-survey" });
    const badge = (text, cls, title) => box.append(Object.assign(document.createElement("span"), { className: `patch-badge ${cls}`, textContent: text, title }));
    if (c.security) badge(`🛡 ${c.security} sécurité`, "sec", "Mises à jour de sécurité en attente : la VM passe en orange");
    if (c.pending) badge(`${c.pending} MAJ`, "pending", "Mises à jour en attente (toutes)");
    if (c.pending === 0 && !c.security) badge("✓ à jour", "ok", "Aucune mise à jour en attente lors du relevé");
    if (c.reboot) badge("↻ reboot requis", "reboot", "Redémarrage requis (noyau ou bibliothèques mis à jour)");
    const at = new Date(c.at);
    box.append(Object.assign(document.createElement("span"), { className: "patch-survey-at", textContent: `relevé ${at.toLocaleDateString(dateLocale(), { day: "2-digit", month: "2-digit" })} ${at.toLocaleTimeString(dateLocale(), { hour: "2-digit", minute: "2-digit" })}`, title: [c.os, c.host].filter(Boolean).join(" · ") }));
    return box;
}

const patchLabel = (d) => (d === null ? "à planifier" : d < 0 ? `en retard de ${-d} j` : d === 0 ? "aujourd'hui" : d === 1 ? "demain" : `dans ${d} j`);

function openPatches() {
    $("#patches").hidden = false;
    send({ t: "patch-list" });
    renderPatches();
}

/** Inventaire : du prochain patch le plus proche au plus lointain, filtré par la recherche. */
function renderPatches() {
    if ($("#patches").hidden) return;
    const vms = state.patches ?? [];
    const q = fold($("#patch-search").value.trim());
    renderPatchFilters(vms);
    const shown = vms.filter((v) => !q || fold(`${v.name} ${v.host} ${v.env} ${v.description} ${(v.tags ?? []).join(" ")} ${v.cluster ?? ""} ${v.clusterSet ?? ""} ${(state.patchClusters?.[v.cluster]?.vips ?? []).map((x) => x.address).join(" ")}`).includes(q))
        .filter((v) => !patchFilter.env || v.env === patchFilter.env)
        .filter((v) => [...patchFilter.tags].every((t) => (v.tags ?? []).includes(t)))
        .filter((v) => !patchFilter.state || PATCH_STATES.find(([k]) => k === patchFilter.state)?.[2](v))
        .filter((v) => !patchFilter.pick || patchFilter.pick.names.has(v.name))
        .sort((a, b) => (a.decommissioned === true) - (b.decommissioned === true)
            || (patchSort.desc ? -1 : 1) * PATCH_SORTS[patchSort.key][1](a, b) || a.name.localeCompare(b.name, "fr", { numeric: true }));
    // Titres de colonnes : flèche sur la colonne triée
    for (const th of document.querySelectorAll(".patch-table th[data-sort]")) {
        const on = th.dataset.sort === patchSort.key;
        th.classList.toggle("sorted", on);
        th.dataset.arrow = on ? (patchSort.desc ? "↓" : "↑") : "";
    }
    const late = vms.filter((v) => !v.decommissioned && (patchDays(v) ?? 0) < 0).length;
    const decom = vms.filter((v) => v.decommissioned).length;
    $("#patch-summary").textContent = vms.length ? `${vms.length - decom} VM(s)${late ? ` · ${late} en retard` : ""}${decom ? ` · ${decom} décommissionnée(s)` : ""}` : "";
    const grouped = patchGroupByCluster && shown.some((v) => v.cluster);
    const rowFor = (vm) => {
        const d = patchDays(vm);
        const decom = vm.decommissioned === true;
        const level = decom ? "decom" : vmLevel(vm);
        const tr = Object.assign(document.createElement("tr"), { className: `patch-${level}` });
        const cell = (content, cls = "") => { const td = Object.assign(document.createElement("td"), { className: cls }); td.append(...[content].flat()); return td; };
        const name = Object.assign(document.createElement("strong"), { textContent: vm.name });
        name.dataset.noI18n = "";   // données saisies : jamais traduites
        const role = vm.role ? Object.assign(document.createElement("span"), { className: `patch-role role-${vm.role}`, textContent: vm.role === "primary" ? "★ PRIMARY" : "SECONDARY", title: vm.role === "primary" ? "Nœud PRIMARY du cluster (lecture / écriture) : à patcher en dernier" : "Nœud SECONDARY du cluster" }) : "";
        const env = Object.assign(document.createElement("span"), { className: `patch-env env-${vm.env}`, textContent: vm.env });
        const tags = (vm.tags ?? []).map((t) => { const el = Object.assign(document.createElement("span"), { className: "patch-tag", textContent: t }); el.dataset.noI18n = ""; return el; });
        const where = [vm.host && vm.host !== vm.name ? vm.host : "", vm.identity ? `clé : ${vm.identity.split(/[\\/]/).pop()}` : ""].filter(Boolean).join(" · ");
        const host = where ? Object.assign(document.createElement("div"), { className: "hint", textContent: where, title: vm.identity || "" }) : "";
        const next = Object.assign(document.createElement("div"), { textContent: decom ? "—" : frDate(vm.nextPatch) });
        const when = Object.assign(document.createElement("div"), { className: "patch-when", textContent: decom ? "hors suivi" : patchLabel(d) });
        const survey = decom || !vm.check ? "" : surveyBadges(vm.check);
        const decomBadge = decom ? Object.assign(document.createElement("span"), { className: "patch-decom-badge", textContent: `DÉCOMMISSIONNÉE${vm.decommissionedAt ? ` le ${frDate(vm.decommissionedAt)}` : ""}` }) : "";
        const btn = (label, title, run, cls = "") => { const b = Object.assign(document.createElement("button"), { type: "button", textContent: label, title, className: cls }); b.addEventListener("click", run); return b; };
        const del = btn("Supprimer", "Retirer cette VM de l'inventaire", (ev) => armOrRun(ev.target, "Confirmer ?", () => send({ t: "patch-delete", id: vm.id })), "danger");
        tr.append(
            cell(Object.assign(document.createElement("span"), { className: "patch-dot", textContent: decom ? "⚫" : level === "rouge" ? "🔴" : level === "orange" ? "🟠" : "🟢" })),
            // Mode regroupé : cluster et profil déjà dans l'en-tête du groupe
            cell([name, " ", ...(decom ? [decomBadge, " "] : []), ...(role ? [role, " "] : []), env, ...tags.flatMap((t) => [" ", t]), grouped ? "" : patchClusterLine(vm), host]),
            Object.assign(cell(vm.description || "—", "patch-desc"), { translate: false }),
            cell(`${frDate(vm.lastPatch)}${vm.everyDays ? ` · tous les ${vm.everyDays} j` : ""}`),
            cell([next, when, survey]),
            cell(decom ? [
                // Décommissionnée : plus de patch ni de connexion ; remise en service ou suppression définitive
                btn("Remettre en service", "La VM revient dans le suivi (voyant, alertes, échéances)", () => send({ t: "patch-decom", id: vm.id, on: false }), "primary"),
                btn("Modifier", "", () => openPatchForm(vm)),
                del
            ] : [
                btn("Patché", "Dernier patch = aujourd'hui ; prochain = aujourd'hui + fréquence", () => send({ t: "patch-done", id: vm.id }), "primary"),
                btn("SSH", vm.identity ? `Tape « ssh -i ${vm.identity} » vers la VM (sans Entrée)` : "Tape « ssh » vers la VM dans le terminal (sans Entrée)", () => {
                    $("#patches").hidden = true;
                    const key = vm.identity ? `-i ${/\s/.test(vm.identity) ? `"${vm.identity}"` : vm.identity} ` : "";
                    typeInTerminal(`ssh ${key}${vm.host || vm.name}`);
                }),
                btn("Modifier", "", () => openPatchForm(vm)),
                btn("Dupliquer", "Nouvelle VM à partir de celle-ci (nom suivant proposé : app-prod-01 → app-prod-02)", () => openPatchForm(vm, { duplicate: true })),
                del
            ], "patch-actions")
        );
        return tr;
    };
    // Regroupement par cluster : en-tête par cluster (environnement, ClusterSet, profil, nœuds, état), nœuds dessous ;
    // ordre des groupes = celui du nœud le plus haut dans le tri ; VMs sans cluster à la fin
    if (grouped) {
        const groups = new Map();
        for (const vm of shown) {
            const key = vm.cluster || "";
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(vm);
        }
        // Dans un cluster : le PRIMARY en tête, les autres dans l'ordre du tri
        for (const list of groups.values()) list.sort((a, b) => (b.role === "primary") - (a.role === "primary"));
        const allDecom = (cluster) => cluster && vms.filter((v) => v.cluster === cluster).every((v) => v.decommissioned);
        const ordered = [...groups].sort(([a], [b]) => (a === "") - (b === "") || allDecom(a) - allDecom(b));
        // Un bloc par cluster : espace, en-tête, nœuds (sauf replié) encadrés aux couleurs de l'environnement
        $("#patch-list").replaceChildren(...ordered.flatMap(([cluster, nodes], gi) => {
            const env = !cluster ? "" : allDecom(cluster) ? "decom" : clusterEnv(cluster, vms);
            const folded = cluster && patchFolded.has(cluster);
            const rows = folded ? [] : nodes.map((vm, i) => {
                const tr = rowFor(vm);
                tr.classList.add("patch-node", `grp-${cluster ? env || "autre" : "none"}`);
                if (i === nodes.length - 1) tr.classList.add("last");
                return tr;
            });
            const spacer = Object.assign(document.createElement("tr"), { className: "patch-spacer" });
            spacer.append(Object.assign(document.createElement("td"), { colSpan: 6 }));
            return [...(gi ? [spacer] : []), patchClusterHeader(cluster, nodes, vms, folded), ...rows];
        }));
    } else {
        $("#patch-list").replaceChildren(...shown.map(rowFor));
    }
    if (!shown.length) {
        const tr = document.createElement("tr");
        tr.append(Object.assign(document.createElement("td"), { colSpan: 6, className: "hint", textContent: vms.length ? "aucune VM ne correspond" : "aucune VM : « + VM » pour commencer" }));
        $("#patch-list").append(tr);
    }
}

/**
 * Nom libre pour une copie : numéro final incrémenté (app-prod-01 → app-prod-02, en gardant les zéros),
 * sinon « -2 », « -3 »… ; jamais un nom déjà pris (sans tenir compte de la casse).
 */
function nextVmName(name) {
    const taken = new Set((state.patches ?? []).map((v) => v.name.toLowerCase()));
    const m = /^(.*?)(\d+)$/.exec(name);
    for (let i = 1; i < 1000; i++) {
        const candidate = m ? `${m[1]}${String(Number(m[2]) + i).padStart(m[2].length, "0")}` : `${name}-${i + 1}`;
        if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return `${name}-copie`;
}

function openPatchForm(vm = null, { duplicate = false } = {}) {
    patchEditing = duplicate ? null : vm;
    const name = duplicate ? nextVmName(vm.name) : vm?.name ?? "";
    $("#patch-form-title").textContent = duplicate ? `Nouvelle VM, copie de « ${vm.name} »` : vm ? `Modifier « ${vm.name} »` : "Nouvelle VM";
    $("#patch-name").value = name;
    // Copie : le nom de la VM d'origine remplacé dans l'hôte (admin@app-prod-01.client.fr → admin@app-prod-02.client.fr)
    $("#patch-host").value = duplicate && vm.host ? vm.host.split(vm.name).join(name) : vm?.host ?? "";
    $("#patch-identity").value = vm?.identity ?? "";
    // Clés privées de ~/.ssh proposées (mêmes que la touche connexion -i)
    send({ t: "param-options", req: "patch-identity", name: "identity" });
    $("#patch-env").value = vm?.env ?? "production";
    $("#patch-last").value = vm?.lastPatch ?? "";
    $("#patch-next").value = vm?.nextPatch ?? "";
    $("#patch-every").value = vm?.everyDays ?? "";
    $("#patch-desc").value = vm?.description ?? "";
    $("#patch-tags").value = (vm?.tags ?? []).join(", ");
    $("#patch-cluster").value = vm?.cluster ?? "";
    $("#patch-clusterset").value = vm?.clusterSet ?? "";
    $("#patch-profile").value = vm?.profile ?? "";
    // Copie d'un nœud : jamais un second PRIMARY
    $("#patch-role").value = duplicate && vm?.role ? "secondary" : vm?.role ?? "";
    $("#patch-decom").checked = !duplicate && vm?.decommissioned === true;
    // Clusters et ClusterSets déjà utilisés proposés à la saisie
    const usedValues = (k) => [...new Set((state.patches ?? []).map((v) => v[k]).filter(Boolean))].sort();
    $("#patch-cluster-list").replaceChildren(...usedValues("cluster").map((c) => new Option(c)));
    $("#patch-clusterset-list").replaceChildren(...usedValues("clusterSet").map((c) => new Option(c)));
    // Tags déjà utilisés proposés à la saisie
    const known = [...new Set((state.patches ?? []).flatMap((v) => v.tags ?? []))].sort();
    $("#patch-tag-list").replaceChildren(...known.map((t) => new Option(t)));
    $("#patch-error").hidden = true;
    $("#patch-form").hidden = false;
    $("#patch-form").scrollIntoView({ block: "nearest" });
    $("#patch-name").focus();
    if (duplicate) $("#patch-name").select();
}

function savePatch() {
    $("#patch-error").hidden = true;
    patchPending = true;
    send({ t: "patch-save", vm: {
        ...(patchEditing ? { id: patchEditing.id } : {}),
        name: $("#patch-name").value, host: $("#patch-host").value, identity: $("#patch-identity").value, env: $("#patch-env").value,
        lastPatch: $("#patch-last").value, nextPatch: $("#patch-next").value,
        everyDays: $("#patch-every").value, description: $("#patch-desc").value, tags: $("#patch-tags").value,
        cluster: $("#patch-cluster").value, clusterSet: $("#patch-clusterset").value, profile: $("#patch-profile").value, role: $("#patch-role").value,
        decommissioned: $("#patch-decom").checked, decommissionedAt: $("#patch-decom").checked ? patchEditing?.decommissionedAt ?? "" : ""
    } });
}

/**
 * Boutons de filtre : « Toutes », un par environnement présent, un par tag (avec le nombre de VMs).
 * Environnement : un seul à la fois ; tags : combinés (la VM doit les avoir tous). Re-cliquer retire le filtre.
 */
function renderPatchFilters(vms) {
    const count = (pred) => vms.filter(pred).length;
    const envs = [...new Set(vms.map((v) => v.env))].sort();
    const tags = [...new Set(vms.flatMap((v) => v.tags ?? []))].sort();
    const chip = (label, n, on, cls, click) => {
        const b = Object.assign(document.createElement("button"), { type: "button", className: `patch-chip ${cls}${on ? " on" : ""}`, textContent: `${label} ${n}` });
        b.setAttribute("aria-pressed", String(on));
        b.addEventListener("click", click);
        return b;
    };
    const all = chip("Toutes", vms.length, !patchFilter.env && !patchFilter.tags.size && !patchFilter.state && !patchFilter.pick, "all", () => { patchFilter.env = null; patchFilter.tags.clear(); patchFilter.state = null; patchFilter.pick = null; renderPatches(); });
    // Sélection venue du tableau de bord : retirée d'un clic
    const pick = patchFilter.pick ? Object.assign(document.createElement("button"), { type: "button", className: "patch-chip pick on", textContent: `Sélection : ${patchFilter.pick.label} (${count((v) => patchFilter.pick.names.has(v.name))}) ✕`, title: "Retirer la sélection du tableau de bord" }) : null;
    pick?.addEventListener("click", () => { patchFilter.pick = null; renderPatches(); });
    const envChips = envs.map((e) => chip(e, count((v) => v.env === e), patchFilter.env === e, `env env-${e}`, () => { patchFilter.env = patchFilter.env === e ? null : e; renderPatches(); }));
    const tagChips = tags.map((t) => chip(`#${t}`, count((v) => (v.tags ?? []).includes(t)), patchFilter.tags.has(t), "tag", () => { patchFilter.tags.has(t) ? patchFilter.tags.delete(t) : patchFilter.tags.add(t); renderPatches(); }));
    // Filtre devenu sans objet (tag supprimé) : oublié
    for (const t of patchFilter.tags) if (!tags.includes(t)) patchFilter.tags.delete(t);
    if (patchFilter.env && !envs.includes(patchFilter.env)) patchFilter.env = null;
    const row1 = Object.assign(document.createElement("div"), { className: "patch-filter-row" });
    row1.append(all, ...(pick ? [pick] : []), ...envChips, ...(tagChips.length ? [Object.assign(document.createElement("span"), { className: "patch-sep" }), ...tagChips] : []));
    // États : un à la fois (re-cliquer le retire) ; seuls ceux qui concernent au moins une VM, ou celui choisi
    const states = PATCH_STATES.filter(([k, , pred]) => count(pred) || patchFilter.state === k)
        .map(([k, label, pred]) => chip(label, count(pred), patchFilter.state === k, `state state-${k}`, () => { patchFilter.state = patchFilter.state === k ? null : k; renderPatches(); }));
    const sort = Object.assign(document.createElement("select"), { className: "patch-sort", title: "Trier l'inventaire" });
    sort.append(...Object.entries(PATCH_SORTS).map(([k, [label]]) => new Option(`Trier par : ${label}`, k, false, k === patchSort.key)));
    sort.addEventListener("change", () => setPatchSort(sort.value, false));
    const dir = Object.assign(document.createElement("button"), { type: "button", className: "patch-chip patch-dir", textContent: patchSort.desc ? "↓ décroissant" : "↑ croissant", title: "Inverser l'ordre" });
    dir.addEventListener("click", () => setPatchSort(patchSort.key, !patchSort.desc));
    const group = Object.assign(document.createElement("button"), { type: "button", className: `patch-chip patch-group-toggle${patchGroupByCluster ? " on" : ""}`, textContent: "⬡ par cluster", title: "Regrouper les nœuds d'un même cluster (en-tête avec environnement, ClusterSet, état)" });
    group.setAttribute("aria-pressed", String(patchGroupByCluster));
    group.addEventListener("click", () => {
        patchGroupByCluster = !patchGroupByCluster;
        try { localStorage.setItem("deck-patch-group", patchGroupByCluster ? "cluster" : ""); } catch { /* choix non retenu */ }
        renderPatches();
    });
    const row2 = Object.assign(document.createElement("div"), { className: "patch-filter-row" });
    row2.append(Object.assign(document.createElement("span"), { className: "patch-filter-label", textContent: "État" }), ...states,
        Object.assign(document.createElement("span"), { className: "grow" }), ...(vms.some((v) => v.cluster) ? [group] : []), sort, dir);
    $("#patch-filters").replaceChildren(row1, row2);
    $("#patch-filters").hidden = vms.length === 0;
}

// ----- Import en masse (CSV) -----

let patchImportCsv = null;   // contenu du fichier choisi, en attente de confirmation

function downloadText(text, filename, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = Object.assign(document.createElement("a"), { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function readPatchFile(file) {
    $("#patch-import-file").value = "";
    if (!file) return;
    if (file.size > 500000) return toast("fichier trop gros (500 Ko au plus)");
    patchImportCsv = await file.text();
    $("#patch-import-title").textContent = file.name;
    send({ t: "patch-import", csv: patchImportCsv, dryRun: true });   // aperçu : rien n'est écrit
}

/** Aperçu (ce qui sera ajouté / mis à jour, lignes ignorées) puis résultat de l'import. */
function showPatchImport(msg) {
    const errors = msg.errors ?? [];
    if (!msg.dryRun) {
        patchImportCsv = null;
        $("#patch-import-confirm").hidden = true;
        return toast(`import : ${msg.added} VM(s) ajoutée(s), ${msg.updated} mise(s) à jour${errors.length ? `, ${errors.length} ligne(s) ignorée(s)` : ""}`, "ok");
    }
    $("#patch-import-summary").textContent = msg.added || msg.updated
        ? `${msg.added} VM(s) à ajouter, ${msg.updated} à mettre à jour${errors.length ? ` ; ${errors.length} ligne(s) ignorée(s) :` : "."}`
        : `aucune VM à importer${errors.length ? ` ; ${errors.length} ligne(s) en erreur :` : "."}`;
    $("#patch-import-errors").replaceChildren(...errors.slice(0, 50).map((e) => Object.assign(document.createElement("li"), { textContent: e })));
    $("#patch-import-ok").disabled = !(msg.added || msg.updated);
    $("#patch-form").hidden = true;
    $("#patch-import-confirm").hidden = false;
}

const PATCH_TEMPLATE = "\uFEFFnom;hote;cle;environnement;dernier_patch;prochain_patch;frequence;tags;cluster;clusterset;profil;role;description\r\n"
    + "app-prod-01;app-prod-01;~/.ssh/id_ed25519;production;10/10/2026;;30;linux, critique;;;standard;;API paiement (RHEL 9), maintenance le mardi 22h\r\n"
    + "mysql-rec-01;admin@10.0.0.21;;recette;;15/12/2026;30;linux, mysql;CL-MYSQL-REC;CS_MYSQL;mysql;primary;Nœud 1 du cluster MySQL de recette\r\n"
    + "mysql-rec-02;admin@10.0.0.22;;recette;;16/12/2026;30;linux, mysql;CL-MYSQL-REC;CS_MYSQL;mysql;secondary;Nœud 2 (un nœud à la fois)\r\n";

/** VM passée à l'orange / au rouge : message et notification du système (si autorisée), une fois par seuil. */
function patchAlert(alerts) {
    // Chaque VM traduite à part (liste assemblée : un modèle ne saurait pas où couper) ; aussi pour la notification système
    const text = alerts.map((a) => tr(`${a.target} : ${a.days === null ? "patch à planifier" : a.days < 0 ? `patch en retard de ${-a.days} j` : `patch ${patchLabel(a.days)}`}`)).join(" · ");
    const red = alerts.some((a) => a.level === "rouge");
    toast(`${red ? "🔴" : "🟠"} ${text}`, red ? "ko" : "ok");
    if ("Notification" in window && Notification.permission === "granted") {
        new Notification(tr(red ? "Deck : patch urgent" : "Deck : patch à prévoir"), { body: text, icon: "/img/icon-64.png", tag: "deck-patches" });
    }
}

// ---------- Échéances (calendrier) et synthèse du client ----------

let agendaEvents = [];
const monthStart = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
let agendaMonth = monthStart(new Date());
let summaryMarkdown = "";
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function openAgenda() {
    $("#patches").hidden = true;
    $("#picker").hidden = true;
    $("#agenda").hidden = false;
    agendaMonth = monthStart(new Date());
    send({ t: "agenda" });
    renderAgenda();
}

/** Étiquette d'une échéance (calendrier, liste) : couleur par type, contour par environnement, niveau d'urgence. */
function agendaChip(e, short = false) {
    const chip = Object.assign(document.createElement("span"), {
        className: `ag-chip ${e.kind === "patch" ? "ag-patch" : "ag-cert"} lvl-${e.level}${e.env === "production" ? " ag-prod" : ""}`,
        textContent: short ? e.title.replace(/^Patch /, "").replace(/^Expiration du certificat /, "🔒 ") : e.title,
        // Détail assemblé par le serveur (« description · hôte … · tous les … j ») : chaque morceau traduit à part
        title: `${e.title} (${e.env})${e.detail ? `\n${e.detail.split(" · ").map((part) => tr(part)).join(" · ")}` : ""}`
    });
    if (e.kind === "patch") {
        chip.classList.add("clickable");
        chip.addEventListener("click", () => {
            $("#agenda").hidden = true;
            openPatches();
            $("#patch-search").value = e.title.replace(/^Patch /, "");
            renderPatches();
        });
    }
    return chip;
}

function renderAgenda() {
    if ($("#agenda").hidden) return;
    const today = isoDay(new Date());
    const y = agendaMonth.getFullYear(), m = agendaMonth.getMonth();
    $("#agenda-title").textContent = agendaMonth.toLocaleDateString(dateLocale(), { month: "long", year: "numeric" });
    const byDay = new Map();
    for (const e of agendaEvents) byDay.set(e.date, [...(byDay.get(e.date) ?? []), e]);
    const cells = ["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."].map((d) => Object.assign(document.createElement("div"), { className: "ag-head", textContent: d }));
    const first = new Date(y, m, 1);
    const offset = (first.getDay() + 6) % 7;   // lundi en premier
    const days = new Date(y, m + 1, 0).getDate();
    const total = Math.ceil((offset + days) / 7) * 7;
    for (let i = 0; i < total; i++) {
        const d = new Date(y, m, 1 - offset + i);
        const key = isoDay(d);
        const cell = Object.assign(document.createElement("div"), { className: `ag-day${d.getMonth() !== m ? " other" : ""}${key === today ? " today" : ""}${d.getDay() === 0 || d.getDay() === 6 ? " weekend" : ""}` });
        cell.append(Object.assign(document.createElement("span"), { className: "ag-num", textContent: d.getDate() }));
        const list = byDay.get(key) ?? [];
        for (const e of list.slice(0, 3)) cell.append(agendaChip(e, true));
        if (list.length > 3) cell.append(Object.assign(document.createElement("span"), { className: "ag-more", textContent: `+${list.length - 3}`, title: list.slice(3).map((e) => e.title).join("\n") }));
        cells.push(cell);
    }
    $("#agenda-grid").replaceChildren(...cells);
    // Liste : en retard, puis les 60 prochains jours
    const limit = isoDay(new Date(Date.now() + 60 * 86400000));
    const late = agendaEvents.filter((e) => e.date < today);
    const soon = agendaEvents.filter((e) => e.date >= today && e.date <= limit);
    const item = (e) => {
        const li = document.createElement("li");
        const days = Math.round((Date.parse(`${e.date}T00:00:00`) - Date.parse(`${today}T00:00:00`)) / 86400000);
        li.append(Object.assign(document.createElement("span"), { className: "ag-date", textContent: `${frDate(e.date)} · ${days < 0 ? (e.kind === "certificat" ? `expiré depuis ${-days} j` : `${-days} j de retard`) : days === 0 ? "aujourd'hui" : `J-${days}`}` }),
            agendaChip(e), Object.assign(document.createElement("span"), { className: `patch-env env-${e.env}`, textContent: e.env }));
        return li;
    };
    const items = [...late.map(item), ...soon.map(item)];
    if (!items.length) items.push(Object.assign(document.createElement("li"), { className: "hint", textContent: agendaEvents.length ? "rien dans les 60 prochains jours" : "aucune échéance : ajoute des VMs (Patchs) ou des certificats (mission)" }));
    $("#agenda-list").replaceChildren(...items);
    const prod = soon.filter((e) => e.env === "production").length;
    $("#agenda-summary").textContent = `${soon.length} dans les 60 jours${prod ? ` dont ${prod} en production` : ""}${late.length ? ` · ${late.length} en retard` : ""}`;
}

function openSummary() {
    $("#summary").hidden = false;
    $("#summary-refresh").disabled = true;
    if (!summaryMarkdown) $("#summary-view").innerHTML = '<p class="hint">calcul de la synthèse…</p>';
    send({ t: "summary" });
}

// ---------- Rapport d'intervention ----------

function reportFrom() {
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    switch ($("#report-period").value) {
        case "4h": return new Date(now - 4 * 3600e3);
        case "yesterday": return new Date(midnight - 86400e3);
        case "7d": return new Date(now - 7 * 86400e3);
        case "custom": return $("#report-from").value ? new Date($("#report-from").value) : midnight;
        default: return midnight;
    }
}

function openReport() {
    $("#report").hidden = false;
    buildReport();
}

function buildReport() {
    $("#report-build").disabled = true;
    $("#report-build").textContent = "Génération…";
    send({ t: "report", from: reportFrom().toISOString(), withSessions: $("#report-sessions").checked });
}

function reportName() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `rapport-intervention-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function downloadReport() {
    const text = $("#report-text").value;
    if (!text.trim()) return toast("rapport vide : clique sur Générer");
    const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `${reportName()}.md` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`rapport enregistré : ${reportName()}.md (dans Téléchargements)`, "ok");
}

/** Le rapport devient une note du coffre (chiffrée), modifiable ensuite comme les autres. */
function reportToVault() {
    const text = $("#report-text").value;
    if (!text.trim()) return toast("rapport vide : clique sur Générer");
    if (!state.vault.unlocked) return toast("déverrouille d'abord le coffre (bouton cadenas)");
    const title = `Rapport d'intervention du ${new Date().toLocaleDateString(dateLocale())}`;
    send({ t: "note-save", title, body: text, req: `report-${crypto.randomUUID()}` });
    toast(`rapport enregistré dans le coffre : « ${title} »`, "ok");
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
$("#report-open").addEventListener("click", openReport);
$("#patch-new").addEventListener("click", () => openPatchForm());
// Champs de date : un clic n'importe où dans le champ ouvre le calendrier (pas seulement sur la petite icône)
document.addEventListener("click", (ev) => {
    const input = ev.target.closest?.('input[type="date"], input[type="datetime-local"]');
    if (!input || input.disabled || input.readOnly) return;
    try { input.showPicker(); } catch { /* navigateur sans showPicker : icône du champ */ }
});
$("#patch-agenda").addEventListener("click", openAgenda);
$("#patch-dash-open").addEventListener("click", openPatchDash);
$("#dash-close").addEventListener("click", () => { $("#patch-dash").hidden = true; });
$("#dash-inventory").addEventListener("click", () => { $("#patch-dash").hidden = true; openPatches(); });
$("#patch-dash").addEventListener("mousedown", (ev) => { if (ev.target.id === "patch-dash") $("#patch-dash").hidden = true; });
$("#patch-dash").addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Escape") { ev.preventDefault(); $("#patch-dash").hidden = true; } });
// Infobulle du tableau de bord : tout élément avec data-tip
$("#patch-dash").addEventListener("mousemove", (ev) => {
    const target = ev.target.closest("[data-tip]");
    const tip = $("#dash-tip");
    if (!target) { tip.hidden = true; return; }
    tip.textContent = target.dataset.tip;
    tip.hidden = false;
    const box = $(".dash-box").getBoundingClientRect();
    tip.style.left = `${Math.min(ev.clientX - box.left + 14, box.width - tip.offsetWidth - 8)}px`;
    tip.style.top = `${ev.clientY - box.top + 16}px`;
});
$("#patch-dash").addEventListener("mouseleave", () => { $("#dash-tip").hidden = true; });
$("#agenda-close").addEventListener("click", () => { $("#agenda").hidden = true; });
$("#agenda").addEventListener("mousedown", (ev) => { if (ev.target.id === "agenda") $("#agenda").hidden = true; });
$("#agenda").addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Escape") { ev.preventDefault(); $("#agenda").hidden = true; } });
$("#agenda-prev").addEventListener("click", () => { agendaMonth = new Date(agendaMonth.getFullYear(), agendaMonth.getMonth() - 1, 1); renderAgenda(); });
$("#agenda-next").addEventListener("click", () => { agendaMonth = new Date(agendaMonth.getFullYear(), agendaMonth.getMonth() + 1, 1); renderAgenda(); });
$("#agenda-today").addEventListener("click", () => { agendaMonth = monthStart(new Date()); renderAgenda(); });
$("#agenda-ics").addEventListener("click", () => send({ t: "agenda", ics: true }));
$("#agenda-summary-open").addEventListener("click", () => { $("#agenda").hidden = true; openSummary(); });
$("#summary-close").addEventListener("click", () => { $("#summary").hidden = true; });
$("#summary").addEventListener("mousedown", (ev) => { if (ev.target.id === "summary") $("#summary").hidden = true; });
$("#summary").addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Escape") { ev.preventDefault(); $("#summary").hidden = true; } });
$("#summary-refresh").addEventListener("click", openSummary);
$("#summary-copy").addEventListener("click", () => {
    navigator.clipboard.writeText(summaryMarkdown).then(() => toast("synthèse copiée (Markdown)", "ok"), () => toast("copie refusée par le navigateur"));
});
$("#summary-download").addEventListener("click", () => {
    const name = `synthese-${new Date().toISOString().slice(0, 10)}.md`;
    downloadText(summaryMarkdown, name, "text/markdown;charset=utf-8");
    toast(`synthèse enregistrée : ${name} (dans Téléchargements)`, "ok");
});
$("#patch-import").addEventListener("click", () => $("#patch-import-file").click());
$("#patch-import-file").addEventListener("change", (ev) => readPatchFile(ev.target.files[0]));
$("#patch-import-ok").addEventListener("click", () => { if (patchImportCsv) send({ t: "patch-import", csv: patchImportCsv, dryRun: false }); });
$("#patch-import-cancel").addEventListener("click", () => { patchImportCsv = null; $("#patch-import-confirm").hidden = true; });
$("#patch-export").addEventListener("click", () => send({ t: "patch-export" }));
$("#patch-template").addEventListener("click", (ev) => { ev.preventDefault(); downloadText(PATCH_TEMPLATE, "modele-vms-patchs.csv", "text/csv;charset=utf-8"); toast("modèle CSV téléchargé (dans Téléchargements)", "ok"); });
$("#patch-cancel").addEventListener("click", () => { $("#patch-form").hidden = true; });
$("#patch-vip-cancel").addEventListener("click", () => { $("#patch-vip-form").hidden = true; patchVipEditing = null; });
$("#patch-vip-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    $("#patch-vip-error").hidden = true;
    const vips = $("#patch-vip-list").value.split("\n").map((l) => l.trim()).filter(Boolean);
    send({ t: "patch-vips", cluster: patchVipEditing, vips });
});
$("#patch-form").addEventListener("submit", (ev) => { ev.preventDefault(); savePatch(); });
$("#patch-search").addEventListener("input", renderPatches);
// Clic sur un titre de colonne : tri par cette colonne ; re-clic : ordre inversé
for (const th of document.querySelectorAll(".patch-table th[data-sort]")) {
    th.addEventListener("click", () => setPatchSort(th.dataset.sort, th.dataset.sort === patchSort.key ? !patchSort.desc : false));
}
$("#patches-close").addEventListener("click", () => { $("#patches").hidden = true; });
$("#patches").addEventListener("mousedown", (ev) => { if (ev.target.id === "patches") $("#patches").hidden = true; });
$("#patches").addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Escape") { ev.preventDefault(); $("#patches").hidden = true; }
});
$("#docs-open").addEventListener("click", () => openDocs());
$("#docs-close").addEventListener("click", () => { $("#docs").hidden = true; });
$("#docs").addEventListener("mousedown", (ev) => { if (ev.target.id === "docs") $("#docs").hidden = true; });
// Liens entre pages (sommaire et contenu) : suivis dans la fenêtre
$("#docs").addEventListener("click", (ev) => {
    const a = ev.target.closest("a[data-doc]");
    if (!a) return;
    ev.preventDefault();
    showDoc(a.dataset.doc);
});
$("#docs").addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Escape") { ev.preventDefault(); $("#docs").hidden = true; }
});
// Nom de secret sans espace : chaque espace tapé devient un tiret (curseur conservé)
$("#secret-name").addEventListener("input", (ev) => {
    const el = ev.target;
    if (!/\s/.test(el.value)) return;
    const pos = el.selectionStart;
    el.value = el.value.replace(/\s/g, "-");
    el.setSelectionRange(pos, pos);
});
$("#report-close").addEventListener("click", () => { $("#report").hidden = true; });
$("#report").addEventListener("mousedown", (ev) => { if (ev.target.id === "report") $("#report").hidden = true; });
$("#report-period").addEventListener("change", () => { $("#report-from").hidden = $("#report-period").value !== "custom"; if ($("#report-period").value !== "custom") buildReport(); });
$("#report-from").addEventListener("change", buildReport);
$("#report-sessions").addEventListener("change", buildReport);
$("#report-build").addEventListener("click", buildReport);
$("#report-download").addEventListener("click", downloadReport);
$("#report-note").addEventListener("click", reportToVault);
$("#report-copy").addEventListener("click", () => {
    navigator.clipboard.writeText($("#report-text").value).then(() => toast("rapport copié", "ok"), () => toast("copie refusée par le navigateur"));
});
$("#report").addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Escape") { ev.preventDefault(); $("#report").hidden = true; }
});
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
$("#set-language").addEventListener("change", (ev) => setLang(ev.target.value));   // aperçu immédiat
$("#proxy-toggle").addEventListener("click", (ev) => { ev.stopPropagation(); openProxyMenu(ev.currentTarget); });
$("#proxy-test").addEventListener("click", () => { $("#proxy-state").textContent = "test en cours…"; send({ t: "proxy-test" }); });
// Application installable (Edge / Chrome : « Installer ce site en tant qu'application ») ; le navigateur reste utilisable
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
// Le navigateur signale que le deck est installable : bouton « Installer l'application » (Réglages › Serveur)
let installPrompt = null;
const standalone = () => window.matchMedia("(display-mode: standalone)").matches;
function refreshInstall() {
    $("#install-app").hidden = !installPrompt || standalone();
    $("#install-state").textContent = standalone() ? "Ouvert comme application installée (le navigateur reste utilisable en parallèle)."
        : installPrompt ? "" : "Application : dans Edge ou Chrome, menu ⋯ › Applications › Installer ce site en tant qu'application.";
}
window.addEventListener("beforeinstallprompt", (ev) => { ev.preventDefault(); installPrompt = ev; refreshInstall(); });
window.addEventListener("appinstalled", () => { installPrompt = null; refreshInstall(); toast("application installée : icône dans le menu Démarrer / le Launchpad", "ok"); });
$("#install-app").addEventListener("click", async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => null);
    installPrompt = null;
    refreshInstall();
});
refreshInstall();
$("#share-mode").addEventListener("click", () => applyShare(!document.body.classList.contains("share-mode"), true));
applyShare(loadPref("deck-share") === "1");
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
        language: $("#set-language").value,
        missionTheme: $("#set-theme").value,
        journalEnabled: $("#set-journal-on").checked,
        proxy: { mode: $('input[name="proxy-mode"]:checked')?.value ?? "system", url: $("#set-proxy-url").value, noProxy: $("#set-proxy-noproxy").value },
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
