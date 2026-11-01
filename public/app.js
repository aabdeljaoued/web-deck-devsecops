// Page du deck : grille de touches (rubriques, voyants) et terminaux xterm.js reliés au serveur.
import { Terminal } from "/vendor/xterm.mjs";
import { FitAddon } from "/vendor/addon-fit.mjs";
import { WebLinksAddon } from "/vendor/addon-web-links.mjs";

const $ = (sel) => document.querySelector(sel);

const state = {
    ws: null,
    pages: {},
    titles: {},
    page: "root",
    status: {},
    terms: new Map(),   // sid -> { term, fit, tab, screen, ended }
    active: null,
    pending: []         // textes à envoyer au prochain terminal ouvert par cette page
};
const requestId = crypto.randomUUID();

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
            if (!state.pages[state.page]) state.page = "root";
            fillShells(msg.shells);
            // Reconnexion ou rechargement : on repart des sessions du serveur, sortie rejouée
            for (const sid of [...state.terms.keys()]) removeTerm(sid);
            for (const s of msg.sessions) addTerm(s.sid, s.name, s.replay);
            if (msg.sessions.length) activate(msg.sessions.at(-1).sid);
            else openTerm();
            render();
            break;
        }
        case "opened":
            if (!state.terms.has(msg.sid)) addTerm(msg.sid, msg.name);
            if (msg.by === requestId) {
                activate(msg.sid);
                for (const text of state.pending.splice(0)) send({ t: "in", sid: msg.sid, d: text });
            }
            break;
        case "out":
            state.terms.get(msg.sid)?.term.write(msg.d);
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
    grid.replaceChildren(...state.pages[state.page].map((key) => (key ? keyElement(key) : slot())));
    renderCrumbs();
}

function slot() {
    const el = document.createElement("div");
    el.className = "slot";
    return el;
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
    el.title = key.text ?? key.url ?? key.label;

    const sym = document.createElement("span");
    sym.className = `sym${/^[\x20-\x7E]+$/.test(key.sym) ? " ascii" : ""}`;
    sym.textContent = key.sym;
    if (key.sym.length > 3) sym.style.fontSize = `${Math.max(18, 34 - (key.sym.length - 3) * 5)}px`;
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
    el.title = statusId === "git" ? `${s.repo ?? ""}\nAppui : dépôt suivant` : "Appui : rafraîchir";

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
        case "text": return typeInTerminal(key.text + (key.enter ? "\r" : ""));
        case "clear": {
            const t = state.terms.get(state.active);
            t?.term.clear();
            return typeInTerminal("\x0c");   // Ctrl+L : efface aussi côté shell
        }
    }
}

function pulse(el) {
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
function toast(text) {
    const el = $("#toast");
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 4000);
}

// ---------- Terminaux ----------

function fillShells(names) {
    const select = $("#shell");
    const current = select.value;
    select.replaceChildren(...names.map((name, i) => new Option(name, String(i))));
    if (current && Number(current) < names.length) select.value = current;
    select.hidden = names.length < 2;
}

function openTerm() {
    const { cols, rows } = estimateSize();
    send({ t: "open", shell: Number($("#shell").value || 0), cols, rows, req: requestId });
}

/** Taille du terminal avant sa création, d'après la zone disponible (cellule ~9 x 17 px). */
function estimateSize() {
    const box = $("#screens").getBoundingClientRect();
    return { cols: Math.max(20, Math.floor((box.width - 12) / 9)), rows: Math.max(5, Math.floor((box.height - 12) / 17)) };
}

function addTerm(sid, name, replay = "") {
    const term = new Terminal({
        cursorBlink: true,
        fontFamily: "'Cascadia Mono', Consolas, Menlo, monospace",
        fontSize: 14,
        scrollback: 5000,
        theme: { background: "#000000" }
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((ev, uri) => window.open(uri, "_blank", "noopener,noreferrer")));

    const screen = Object.assign(document.createElement("div"), { className: "screen" });
    $("#screens").append(screen);
    term.open(screen);
    if (replay) term.write(replay);
    term.onData((d) => send({ t: "in", sid, d }));
    term.onResize(({ cols, rows }) => send({ t: "resize", sid, cols, rows }));

    const tab = document.createElement("div");
    tab.className = "tab";
    tab.setAttribute("role", "tab");
    const title = Object.assign(document.createElement("span"), { textContent: `${name} ${sid}` });
    const close = Object.assign(document.createElement("button"), { className: "close", textContent: "×", title: "Fermer ce terminal" });
    close.addEventListener("click", (ev) => {
        ev.stopPropagation();
        closeTerm(sid);
    });
    tab.append(title, close);
    tab.addEventListener("click", () => activate(sid));
    $("#tabs").append(tab);

    state.terms.set(sid, { term, fit, tab, screen, ended: false });
}

function activate(sid) {
    const t = state.terms.get(sid);
    if (!t) return;
    state.active = sid;
    for (const [id, other] of state.terms) {
        other.tab.classList.toggle("active", id === sid);
        other.screen.classList.toggle("active", id === sid);
    }
    requestAnimationFrame(() => {
        t.fit.fit();
        t.term.focus();
    });
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
}

/** Envoie un texte au terminal actif (en ouvre un s'il n'y en a pas, ou s'il est fermé). */
function typeInTerminal(text) {
    const t = state.terms.get(state.active);
    if (!t || t.ended) {
        state.pending.push(text);
        openTerm();
        return;
    }
    send({ t: "in", sid: state.active, d: text });
    t.term.focus();
}

$("#new-tab").addEventListener("click", openTerm);
new ResizeObserver(() => state.terms.get(state.active)?.fit.fit()).observe($("#screens"));

connect();
