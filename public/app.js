// Page du deck : grille de touches (rubriques, voyants) et terminaux xterm.js reliés au serveur.
import { Terminal } from "/vendor/xterm.mjs";
import { FitAddon } from "/vendor/addon-fit.mjs";
import { WebLinksAddon } from "/vendor/addon-web-links.mjs";
import { SearchAddon } from "/vendor/addon-search.mjs";

const $ = (sel) => document.querySelector(sel);

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
function applyWatermark(text = state.settings?.watermark ?? "") {
    const root = document.documentElement;
    const image = state.signature;
    root.style.setProperty("--watermark", JSON.stringify(text));
    if (image) root.style.setProperty("--wm-image", `url("/signature.png?v=${image}")`);
    root.classList.toggle("watermark", Boolean(text) || Boolean(image));
    root.classList.toggle("watermark-image", Boolean(image));
    const info = document.querySelector("#set-signature-state");
    if (info) info.textContent = image ? "image utilisée (elle remplace le texte)" : "aucune image : le texte ci-dessus est utilisé";
    const remove = document.querySelector("#set-signature-remove");
    if (remove) remove.disabled = !image;
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

function setConn(text, cls) {
    const el = $("#conn");
    el.textContent = text;
    el.className = `conn ${cls}`;
}

function handle(msg) {
    switch (msg.t) {
        case "hello": {
            state.pages = msg.pages;
            state.titles = msg.titles;
            state.parents = msg.parents ?? {};
            state.favGroups = msg.favGroups ?? [];
            state.worlds = msg.worlds ?? null;
            state.server = msg.server ?? null;
            state.localUnix = msg.localUnix ?? true;
            state.signature = msg.signature ?? null;
            applyWatermark();
            state.remote = msg.remote ?? {};
            if (msg.tools) applyTools(msg.tools);
            state.status = msg.status ?? {};
            if (msg.vault) applyVault(msg.vault);
            if (msg.settings) {
                state.settings = msg.settings;
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
            applyWatermark();
            if (msg.settings.autoHomeEnabled === false) cancelAutoHome();
            settingsPending = false;
            applyAppearance(msg.settings.appearance, msg.settings.missionTheme);
            break;
        case "vault":
            applyVault(msg);
            if (!msg.unlocked && msg.reason === "inactivité") toast("coffre verrouillé après 15 min d'inactivité", "ok");
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
        case "tools":
            applyTools(msg);
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
            document.querySelectorAll(`[data-status="${msg.id}"]`).forEach((el) => el.replaceWith(statusKey(el.dataset.id, msg.id)));
            break;
        case "ran":
            flash(msg.id, msg.ok);
            if (!msg.ok) toast(msg.error ?? "échec");
            break;
        case "error":
            // Réglages refusés par le serveur : le panneau revient pour corriger
            if (settingsPending) { settingsPending = false; $("#settings").hidden = false; }
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
    renderCrumbs();
}

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
        : statusId === "kube" ? "Appui : changer de contexte ou de namespace" : "Appui : rafraîchir";

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
    switch (key.type) {
        case "folder":
            if (key.fav && state.favEdit) return openFavForm(key);
            return go(key.page);
        case "back": return go(key.page ?? "root");
        case "web":
            if (key.fav && state.favEdit) return openFavForm(key);
            return window.open(key.url, "_blank", "noopener,noreferrer");
        case "fav-add": return openFavForm();
        case "vault": return openVault();
        case "fav-edit":
            state.favEdit = !state.favEdit;
            return render();
        case "run": return send({ t: "run", id: key.id });
        case "text": {
            const command = commandFor(key);
            if (command == null) return toast(`« ${key.label} » n'existe pas pour le shell ${activeKind()}`);
            if (key.enter) return typeInTerminal(command + "\r");
            // Commande à compléter : le texte sélectionné dans le terminal est ajouté à la fin (sans Entrée)
            return typeInTerminal(withSelection(command));
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
    }
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
    requestAnimationFrame(fitVisible);
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
    const panel = $("#picker");
    panel.replaceChildren(Object.assign(document.createElement("p"), { className: "picker-note", textContent: loadingText }));
    panel.hidden = false;
    placePicker();
    send({ t: request });
}

function placePicker() {
    const panel = $("#picker");
    const anchor = pickerAnchor?.isConnected ? pickerAnchor : document.querySelector(`[data-status="${pickerAnchor?.dataset.status}"]`);
    if (!anchor) return;
    const box = anchor.getBoundingClientRect();
    const width = panel.offsetWidth || 320;
    panel.style.top = `${box.bottom + 8}px`;
    panel.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - width - 8))}px`;
}

function closePicker() {
    $("#picker").hidden = true;
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
        main.addEventListener("click", item.onClick);
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

/** Toutes les touches de toutes les rubriques, sans doublons (rubriques, actions, liens). */
function paletteEntries() {
    const seen = new Set();
    const entries = [];
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

function openPalette() {
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

function filterPalette() {
    const words = $("#palette-input").value.toLowerCase().split(/\s+/).filter(Boolean);
    paletteItems = paletteEntries().filter((e) => words.every((w) => e.hay.includes(w))).slice(0, 60);
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
    if (!paletteItems.length) list.append(Object.assign(document.createElement("li"), { className: "palette-empty", textContent: "aucune touche ne correspond" }));
    list.children[paletteIndex]?.scrollIntoView({ block: "nearest" });
}

function runPalette(i) {
    const entry = paletteItems[i];
    if (!entry) return;
    $("#palette").hidden = true;
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

const vaultUi = { tab: "notes", noteId: null, noteColor: "", secretEditing: null, shown: new Map() };
let noteReq = null;
let noteTimer = null;

function openVault() {
    $("#vault").hidden = false;
    renderVault();
    (state.vault.unlocked ? (vaultUi.tab === "notes" ? $("#note-body") : $("#secret-search")) : $("#vault-pass")).focus();
}

function closeVault() {
    flushNote();
    $("#vault").hidden = true;
    state.terms.get(state.active)?.term.focus();
}

/** Nouvel état reçu du serveur : contenu mis à jour, ou tout effacé à l'écran si le coffre est verrouillé. */
function applyVault(view) {
    const wasUnlocked = state.vault.unlocked;
    state.vault = view;
    if (!view.unlocked) {
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
    for (const id of ["#note-title", "#note-body", "#note-delete"]) $(id).disabled = !has;
    renderNoteColors();
}

function loadNoteInEditor() {
    const note = state.vault.notes?.find((n) => n.id === vaultUi.noteId);
    $("#note-title").value = note?.title ?? "";
    $("#note-body").value = note?.body ?? "";
    vaultUi.noteColor = note?.color ?? "";
    renderNoteColors();
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
}

/** Redémarrer arrête les commandes en cours : deuxième clic de confirmation. */
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

const BACKUP_LABELS = { "favoris.json": "Favoris", "settings.json": "Réglages", "vault.enc": "Coffre (chiffré)" };

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
        return label;
    }));
    updateWorldCount();
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
    renderWorldChoices();
    renderServer();
    send({ t: "backup-list" });
    $("#settings").hidden = false;
    refreshVaultIo();
    // Pas de focus sur un champ : le premier clic doit agir directement (sinon il ne sert qu'à quitter ce champ)
    document.activeElement?.blur();
    $(".settings-box").scrollTop = 0;
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

function refreshToolbar() {
    for (const [id, on] of [["#broadcast", state.broadcast], ["#notify", state.notify]]) {
        $(id).classList.toggle("on", on);
        $(id).setAttribute("aria-pressed", String(on));
    }
}

$("#new-tab").addEventListener("click", () => openTerm());
$("#broadcast").addEventListener("click", toggleBroadcast);

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
$("#settings-open").addEventListener("click", openSettings);
$("#server-restart").addEventListener("click", restartServer);
$("#server-diagnostic").addEventListener("click", () => {
    $("#server-diagnostic").disabled = true;
    $("#server-diagnostic").textContent = "Diagnostic…";
    send({ t: "diagnostic" });
});
$("#settings-cancel").addEventListener("click", closeSettings);
$("#set-appearance").addEventListener("change", previewAppearance);
$("#set-autohome-on").addEventListener("change", () => { toggleAutoHomeRow(); if ($("#set-autohome-on").checked) $("#set-autohome").focus(); });
$("#fav-export").addEventListener("click", () => send({ t: "fav-export" }));
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
$("#set-watermark").addEventListener("input", () => applyWatermark($("#set-watermark").value.trim()));
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
        watermark: $("#set-watermark").value,
        ...(state.worlds ? { worlds: worldChoices() } : {})
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
    if (!$("#vault").hidden || !$("#favdialog").hidden || !$("#settings").hidden) return;
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
