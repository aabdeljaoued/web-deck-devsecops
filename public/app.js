// Page du deck : grille de touches (rubriques, voyants) et terminaux xterm.js reliés au serveur.
import { Terminal } from "/vendor/xterm.mjs";
import { FitAddon } from "/vendor/addon-fit.mjs";
import { WebLinksAddon } from "/vendor/addon-web-links.mjs";
import { SearchAddon } from "/vendor/addon-search.mjs";

const $ = (sel) => document.querySelector(sel);

const state = {
    ws: null,
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
    fontSize: Number(loadPref("deck-font")) || 14         // taille du texte des terminaux
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
            state.status = msg.status ?? {};
            state.windowsPty = msg.windowsPty ?? null;
            if (!state.pages[state.page]) state.page = "root";
            fillShells(msg.shells);
            // Reconnexion ou rechargement : on repart des sessions du serveur, sortie rejouée
            for (const sid of [...state.terms.keys()]) removeTerm(sid);
            for (const s of msg.sessions) addTerm(s.sid, s.name, s.kind, s.replay, s.title);
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
            document.querySelectorAll(`[data-status="${msg.id}"]`).forEach((el) => el.replaceWith(statusKey(el.dataset.id, msg.id)));
            break;
        case "ran":
            flash(msg.id, msg.ok);
            if (!msg.ok) toast(msg.error ?? "échec");
            break;
        case "error":
            toast(msg.error);
            break;
    }
}

// ---------- Grille ----------

function render() {
    const grid = $("#grid");
    const { left, right } = rowOrder(state.pages[state.page]);
    // L'espace extensible pousse Verrouiller et clear contre le bord droit de la fenêtre
    const spacer = Object.assign(document.createElement("div"), { className: "spacer" });
    grid.replaceChildren(...left.map(keyElement), spacer, ...right.map(keyElement));
    renderCrumbs();
}

/**
 * Grille 5 x 3 du serveur -> une ligne : à gauche Retour puis les touches dans l'ordre,
 * à droite (alignés sur le bord) Verrouiller puis clear. Les cases vides disparaissent.
 */
function rowOrder(keys) {
    const present = keys.filter(Boolean);
    const first = present.filter((k) => k.type === "back");
    const lock = present.filter((k) => k.pin === "4,2");   // touche épinglée en bas à droite : Verrouiller
    const last = [...lock, ...present.filter((k) => k.type === "clear")];
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

    if (key.badge) {
        const badge = document.createElement("span");
        badge.className = `badge ${key.badge}`;
        el.append(badge);
    }
    el.addEventListener("click", () => press(key, el));
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

function renderCrumbs() {
    const nav = $("#crumbs");
    nav.replaceChildren();
    const home = Object.assign(document.createElement("button"), { textContent: "Accueil" });
    home.addEventListener("click", () => go("root"));
    if (state.page === "root") {
        nav.append(Object.assign(document.createElement("span"), { className: "current", textContent: "Accueil" }));
        return;
    }
    nav.append(home, Object.assign(document.createElement("span"), { className: "sep", textContent: "›" }),
        Object.assign(document.createElement("span"), { className: "current", textContent: state.titles[state.page] }));
}

function go(page) {
    state.page = page;
    render();
}

function press(key, el) {
    pulse(el);
    switch (key.type) {
        case "folder": return go(key.page);
        case "back": return go("root");
        case "web": return window.open(key.url, "_blank", "noopener,noreferrer");
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
        theme: { background: "#000000" },
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
    for (const [page, keys] of Object.entries(state.pages)) {
        for (const key of keys) {
            if (!key || ["status", "back", "clear"].includes(key.type)) continue;
            const detail = key.type === "text" ? commandFor(key) : key.type === "web" ? key.url : key.type === "folder" ? "rubrique" : "programme";
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
document.addEventListener("mousedown", (ev) => {
    if (!$("#picker").hidden && !ev.target.closest("#picker, .key.status")) closePicker();
});
window.addEventListener("resize", () => { if (!$("#picker").hidden) placePicker(); });

/** Raccourcis : Cmd/Ctrl+K palette, Cmd/Ctrl+F recherche, Cmd/Ctrl + / − / 0 taille du texte, Échap ferme. */
document.addEventListener("keydown", (ev) => {
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

connect();
