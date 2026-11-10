// Serveur du deck : page web (grille + terminal), WebSocket pour les terminaux, les voyants et les lanceurs.
// N'écoute que sur 127.0.0.1. Accès protégé par un jeton (cookie), l'en-tête Host et l'origine des WebSockets.
//
//   node server/index.mjs            démarre et ouvre le navigateur
//   node server/index.mjs --no-open  démarre sans ouvrir le navigateur
//   --restarting                     relancé par le bouton Redémarrer : attend que le port se libère
// DECK_SUPERVISOR=launchd|windows : lancé en service (service/), qui le relance s'il s'arrête sur un code ≠ 0.
import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, statSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { WebSocketServer } from "ws";

import { buildDeck, ICONS } from "./catalog.mjs";
import { Actions } from "./actions.mjs";
import { Backups } from "./backups.mjs";
import { copyTemporarily, flushClipboard } from "./clipboard.mjs";
import { ScreenLock } from "./screenlock.mjs";
import { Updater } from "./update.mjs";
import { paramOptions } from "./params.mjs";
import figlet from "figlet";
import { Journal } from "./journal.mjs";
import { runDiagnostic } from "./diagnostic.mjs";
import { Favorites } from "./favorites.mjs";
import { Vault } from "./vault.mjs";
import { Settings } from "./settings.mjs";
import { iconFile } from "./icons.mjs";
import { loadConfig, ROOT } from "./config.mjs";
import { launch, openBrowser, openFolder, platform, windowsPty } from "./platform.mjs";
import { Recorder } from "./recorder.mjs";
import { buildReport } from "./report.mjs";
import { RemoteWatch } from "./remote.mjs";
import { StatusHub } from "./status.mjs";
import { Terminals } from "./terminal.mjs";
import { neededTool, Tools } from "./tools.mjs";

const HOST = "127.0.0.1";
const COOKIE = "deck_token";

const ctx = loadConfig();
const backups = new Backups(path.join(ROOT, ".deck-backups"));
const favorites = new Favorites(path.join(ROOT, "favoris.json"), backups);
const settings = new Settings(path.join(ROOT, "settings.json"), backups);
const actions = new Actions(path.join(ROOT, "actions.json"), backups);
/** Deck avec les favoris et les rubriques choisies dans les Réglages. */
const makeDeck = (worlds = settings.get().worlds, order = settings.get().worldOrder) => buildDeck(ctx, favorites.list(), worlds, order, actions.list());
let deck;
try {
    deck = makeDeck();
} catch (err) {
    // Réglages incompatibles avec config.jsonc (ex. trop de touches sur l'accueil) : rubriques de config.jsonc
    console.warn(`  Rubriques des Réglages ignorées : ${err.message}`);
    deck = makeDeck({}, []);
}
// Outils installables manquants : vérifiés au démarrage, toutes les minutes et à la demande de la page
const tools = new Tools();
const deckTools = () => [...deck.index.values()].map(neededTool).filter(Boolean);
async function checkTools() {
    try {
        if (await tools.check(deckTools())) broadcast({ t: "tools", ...tools.view() });
    } catch (err) {
        console.warn(`  vérification des outils : ${err.message}`);
    }
}
setInterval(checkTools, 60 * 1000).unref();
// Après un clic sur une touche « à installer » : vérification toutes les 3 s pendant 5 min (la touche se rallume
// dès la fin de l'installation), arrêtée plus tôt s'il ne manque plus rien
let toolsWatch = null;
function watchTools() {
    clearInterval(toolsWatch);
    const until = Date.now() + 5 * 60 * 1000;
    toolsWatch = setInterval(async () => {
        await checkTools();
        if (Date.now() > until || !tools.missing.length) { clearInterval(toolsWatch); toolsWatch = null; }
    }, 3000);
    toolsWatch.unref();
}

// Signature en image pour le filigrane des terminaux (Réglages › Apparence) : signature.png, exclu de Git
const SIGNATURE_FILE = path.join(ROOT, "signature.png");
const MAX_SIGNATURE_BYTES = 600 * 1024;
/** Version de l'image (date de modification), ou null s'il n'y en a pas : la page recharge l'image quand elle change. */
const signatureVersion = () => (existsSync(SIGNATURE_FILE) ? Math.round(statSync(SIGNATURE_FILE).mtimeMs) : null);

/** Message "deck" envoyé aux pages après une reconstruction. */
const deckMessage = () => (setImmediate(checkTools), { t: "deck", pages: deck.pages, titles: deck.titles, parents: deck.parents, favGroups: favorites.groups(), worlds: deck.worlds });
const port = ctx.port;
let token = loadToken();
const deckUrlFor = () => `http://${HOST}:${port}/?token=${token}`;
const deckUrl = deckUrlFor();

/** Jeton conservé entre deux démarrages (favori possible), dans un fichier lisible par l'utilisateur seul. */
function loadToken() {
    const file = path.join(ROOT, ".deck-token");
    if (existsSync(file)) {
        const saved = readFileSync(file, "utf8").trim();
        if (/^[0-9a-f]{64}$/.test(saved)) return saved;
    }
    const fresh = randomBytes(32).toString("hex");
    writeFileSync(file, fresh, { mode: 0o600 });
    return fresh;
}

const sameToken = (value) => typeof value === "string" && value.length === token.length && timingSafeEqual(Buffer.from(value), Buffer.from(token));

function cookieToken(req) {
    const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]+)`).exec(req.headers.cookie ?? "");
    return m?.[1];
}

/** Refuse les noms d'hôte inattendus (protection contre le DNS rebinding). */
const allowedHosts = new Set([`${HOST}:${port}`, `localhost:${port}`]);
const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));

// ---------- Fichiers statiques ----------

const nm = (p) => path.join(ROOT, "node_modules", p);
const STATIC = {
    "/": [path.join(ROOT, "public", "index.html"), "text/html; charset=utf-8"],
    "/app.js": [path.join(ROOT, "public", "app.js"), "text/javascript; charset=utf-8"],
    "/markdown.js": [path.join(ROOT, "public", "markdown.js"), "text/javascript; charset=utf-8"],
    "/style.css": [path.join(ROOT, "public", "style.css"), "text/css; charset=utf-8"],
    "/img/deck-bar.jpg": [path.join(ROOT, "public", "img", "deck-bar.jpg"), "image/jpeg"],
    "/img/icon-64.png": [path.join(ROOT, "public", "img", "icon-64.png"), "image/png"],
    "/img/icon-180.png": [path.join(ROOT, "public", "img", "icon-180.png"), "image/png"],
    "/vendor/xterm.mjs": [nm("@xterm/xterm/lib/xterm.mjs"), "text/javascript; charset=utf-8"],
    "/vendor/xterm.css": [nm("@xterm/xterm/css/xterm.css"), "text/css; charset=utf-8"],
    "/vendor/addon-fit.mjs": [nm("@xterm/addon-fit/lib/addon-fit.mjs"), "text/javascript; charset=utf-8"],
    "/vendor/addon-web-links.mjs": [nm("@xterm/addon-web-links/lib/addon-web-links.mjs"), "text/javascript; charset=utf-8"],
    "/vendor/addon-search.mjs": [nm("@xterm/addon-search/lib/addon-search.mjs"), "text/javascript; charset=utf-8"]
};

const SECURITY_HEADERS = {
    "Content-Security-Policy": `default-src 'self'; connect-src 'self' ws://${HOST}:${port} ws://localhost:${port}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store"
};

function send(res, status, body, type = "text/plain; charset=utf-8", extra = {}) {
    res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type, ...extra });
    res.end(body);
}

const server = http.createServer((req, res) => {
    if (!allowedHosts.has(req.headers.host)) return send(res, 421, "Hôte non autorisé");
    const url = new URL(req.url, `http://${req.headers.host}`);

    // Échange du jeton de l'URL contre un cookie, puis URL propre (le jeton ne reste pas dans l'historique)
    if (url.searchParams.has("token")) {
        if (!sameToken(url.searchParams.get("token"))) return send(res, 403, "Jeton invalide");
        return send(res, 303, "", undefined, {
            Location: "/",
            "Set-Cookie": `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`
        });
    }
    if (!sameToken(cookieToken(req))) {
        return send(res, 401, `Accès refusé : ouvre l'adresse affichée par le serveur au démarrage (avec ?token=...).`);
    }
    // Icônes des touches, seulement celles du catalogue (voir server/icons.mjs)
    const logo = /^\/icons\/([a-z0-9-]+)\.svg$/.exec(url.pathname);
    const file = req.method === "GET" && logo && ICONS.has(logo[1]) && iconFile(logo[1]);
    if (file) return send(res, 200, readFileSync(file), "image/svg+xml");
    // Signature en image (filigrane des terminaux) : fichier local, hors Git
    if (req.method === "GET" && url.pathname === "/signature.png") {
        if (!existsSync(SIGNATURE_FILE)) return send(res, 404, "Introuvable");
        return send(res, 200, readFileSync(SIGNATURE_FILE), "image/png", { "Cache-Control": "no-cache" });
    }
    const entry = req.method === "GET" && STATIC[url.pathname];
    if (!entry) return send(res, 404, "Introuvable");
    send(res, 200, readFileSync(entry[0]), entry[1]);
});

// ---------- WebSocket : terminaux, voyants, lanceurs ----------

const terminals = new Terminals(ctx, path.join(ROOT, ".deck-sessions.json"));
const status = new StatusHub(ctx);
const restored = terminals.restore();
const vault = new Vault(path.join(ROOT, "vault.enc"), backups);
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

server.on("upgrade", (req, socket, head) => {
    const ok = req.url === "/ws" && allowedHosts.has(req.headers.host) && allowedOrigins.has(req.headers.origin) && sameToken(cookieToken(req));
    if (!ok) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
});

function broadcast(message) {
    const data = JSON.stringify(message);
    for (const client of wss.clients) if (client.readyState === client.OPEN) client.send(data);
}

/**
 * Version de la page (empreinte des fichiers servis) : un onglet ouvert avant un redémarrage se reconnecte
 * sans recharger son code ; s'il voit une autre version, il se recharge (voir « hello » dans app.js).
 */
function pageBuild() {
    const hash = createHash("sha256");
    for (const [file] of Object.values(STATIC)) {
        try { hash.update(readFileSync(file)); } catch { /* fichier facultatif absent */ }
    }
    return hash.digest("hex").slice(0, 12);
}

// Enregistrement de sessions (preuve d'intervention) : sortie des terminaux enregistrés, .deck-recordings/ (hors Git)
const RECORDINGS = path.join(ROOT, ".deck-recordings");
const recorder = new Recorder(RECORDINGS);
async function stopRecording(sid, reason = null) {
    const done = await recorder.stop(sid);
    broadcast({ t: "rec", sids: recorder.sids() });
    if (done) broadcast({ t: "rec-stopped", sid, ...done, reason });
}

terminals.on("output", (sid, d) => {
    broadcast({ t: "out", sid, d });
    if (!recorder.write(sid, d)) stopRecording(sid, "taille maximale atteinte (50 Mo)");
});
terminals.on("exit", (sid, code) => {
    broadcast({ t: "exit", sid, code });
    stopRecording(sid, "terminal fermé");
});

// Terminaux connectés en ssh / wsl : active les rubriques qui demandent un shell Linux / macOS (Ansible sous Windows).
// DECK_LOCAL_UNIX=0 : se comporter comme sous Windows (pour tester sur un Mac).
const LOCAL_UNIX = platform !== "windows" && process.env.DECK_LOCAL_UNIX !== "0";
const remote = new RemoteWatch(terminals);
remote.on("change", (state) => broadcast({ t: "remote", remote: state }));
remote.start();

// ---------- Missions : thème, rubriques, motif de production, dossier de travail, groupe de favoris ----------

const activeMission = () => {
    const s = settings.get();
    return s.missions.find((m) => m.id === s.activeMission) ?? null;
};

/** Effets côté serveur de la mission active : motif de production du voyant kubectl, dossier des nouveaux terminaux. */
function applyMissionEffects() {
    const m = activeMission();
    status.prodPattern = m?.prodPattern || null;
    status.certTargets = m?.certs ?? [];
    status.refreshCerts?.().catch(() => {});
    terminals.workspaceOverride = m?.workspace || null;
    status.refreshKube?.().catch(() => {});
}
applyMissionEffects();

/** Active une mission ("" = aucune) : ses thème et rubriques remplacent les réglages, après vérification de l'accueil. */
/**
 * Réglages qui appartiennent à la mission active (rubriques, leur ordre, thème) : recopiés dans la mission,
 * sinon la réactiver (en l'enregistrant, par exemple) remettrait ses anciennes rubriques.
 */
function withActiveMission(next) {
    if (!next.activeMission) return next;
    return {
        ...next,
        missions: next.missions.map((m) => (m.id === next.activeMission ? { ...m, worlds: next.worlds, worldOrder: next.worldOrder, theme: next.missionTheme } : m))
    };
}

/** Mise à jour partielle des réglages, recopiée dans la mission active. */
function updateSettings(partial) {
    return settings.update(withActiveMission({ ...settings.get(), ...partial }));
}

function activateMission(id) {
    const m = settings.get().missions.find((x) => x.id === id);
    if (id && !m) throw new Error("mission introuvable");
    const next = settings.check(m ? { activeMission: id, missionTheme: m.theme, worlds: m.worlds, worldOrder: m.worldOrder } : { activeMission: "" });
    const nextDeck = makeDeck(next.worlds, next.worldOrder);   // refus si l'accueil dépasse 18 touches
    settings.save(next);
    deck = nextDeck;
    applyMissionEffects();
    broadcast({ t: "settings", settings: settings.get() });
    broadcast(deckMessage());
    return m;
}

// Journal des actions (Réglages › Journal) : contexte kubectl et terminal ajoutés par le serveur
const journal = new Journal(path.join(ROOT, ".deck-journal.jsonl"));
function logAction(entry, sid) {
    if (!settings.get().journalEnabled) return;
    const kube = status.states.kube;
    const session = sid && terminals.sessions.get(String(sid));
    const e = journal.add({
        ...entry,
        terminal: session ? session.title || session.name : "",
        kube: kube?.context ? `${kube.context} / ${kube.namespace ?? "default"}` : null,
        prod: Boolean(kube?.prod)
    });
    broadcast({ t: "journal-added", entry: e });
}

// Mise à jour en un clic : vérification 30 s après le démarrage, puis toutes les 6 h (Réglages › Serveur)
const updater = new Updater(ROOT);
async function checkUpdate() {
    broadcast({ t: "update", ...(await updater.check()) });
}
setTimeout(checkUpdate, 30 * 1000).unref();
setInterval(checkUpdate, 6 * 60 * 60 * 1000).unref();

// Session verrouillée (écran de verrouillage) : le coffre se verrouille aussitôt
const screenLock = new ScreenLock(remote);
screenLock.on("change", (locked) => { if (locked) vault.lock("écran verrouillé"); });
screenLock.start();
status.on("update", (id, state) => broadcast({ t: "status", id, state }));
// Certificat passé à l'orange / au rouge : notification dans les pages ouvertes (une fois par seuil)
status.alertFile = path.join(ROOT, ".deck-cert-alerts.json");
// Aucune page ouverte (vérification au démarrage) : l'alerte attend la prochaine page, elle n'est pas perdue
let pendingCertAlerts = [];
status.on("cert-alert", (alerts) => {
    if ([...wss.clients].some((c) => c.readyState === c.OPEN)) broadcast({ t: "cert-alert", alerts });
    else pendingCertAlerts.push(...alerts);
});
// Coffre : état et contenu (secrets sans leur valeur) renvoyés à toutes les pages à chaque changement
vault.on("change", (reason) => broadcast({ t: "vault", ...vault.view(), ...(reason ? { reason } : {}) }));

wss.on("connection", (ws) => {
    status.start();
    if (pendingCertAlerts.length) {
        const alerts = pendingCertAlerts;
        pendingCertAlerts = [];
        setTimeout(() => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ t: "cert-alert", alerts })), 1500);
    }
    ws.send(JSON.stringify({
        t: "hello",
        pages: deck.pages,
        titles: deck.titles,
        parents: deck.parents,
        favGroups: favorites.groups(),
        worlds: deck.worlds,
        tools: tools.view(),
        actions: actions.list(),
        localUnix: LOCAL_UNIX,
        update: updater.view(),
        workspace: ctx.workspace,
        prodPattern: ctx.cfg.prodPattern || "prod",
        signature: signatureVersion(),
        remote: remote.view(),
        rec: recorder.sids(),
        build: pageBuild(),
        server: { supervisor: SUPERVISOR, log: SUPERVISOR ? null : LOG_FILE },
        shells: ctx.shells.map(({ name, kind }) => ({ name, kind })),
        windowsPty: windowsPty(),
        sessions: terminals.list(),
        status: status.states,
        vault: vault.view(),
        settings: settings.get()
    }));

    ws.on("message", async (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        const reply = (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
        try {
            switch (msg.t) {
                case "open": {
                    // Dossier de départ demandé par la page : seulement un des dépôts Git connus
                    let cwd;
                    if (msg.cwd != null) {
                        if (!status.findRepos().includes(String(msg.cwd))) throw new Error("dossier non autorisé");
                        cwd = String(msg.cwd);
                    }
                    broadcast({ t: "opened", ...terminals.open(msg.shell, msg.cols, msg.rows, { cwd }), by: msg.req });
                    break;
                }
                case "kube-list": reply({ t: "kube-list", ...(await status.listKube()) }); break;
                case "rec-start": {
                    const session = terminals.sessions.get(String(msg.sid));
                    if (!session) throw new Error("terminal introuvable");
                    const file = recorder.start(session.sid, { cols: Number(msg.cols) || 100, rows: Number(msg.rows) || 30, label: session.title || `${session.name}-${session.sid}` });
                    broadcast({ t: "rec", sids: recorder.sids() });
                    reply({ t: "rec-started", sid: session.sid, file });
                    break;
                }
                case "rec-stop": await stopRecording(String(msg.sid)); break;
                case "rec-list": reply({ t: "rec-list", files: recorder.list(), dir: RECORDINGS }); break;
                // Rapport d'intervention : journal, sessions enregistrées et runbooks d'une période (relu dans la page)
                case "report": {
                    const from = new Date(msg.from);
                    if (Number.isNaN(from.getTime())) throw new Error("début de période invalide");
                    const view = vault.view();
                    const s = settings.get();
                    reply({ t: "report", markdown: buildReport({
                        from, to: new Date(),
                        entries: journal.entries,
                        recordings: recorder.list(500), dir: RECORDINGS,
                        notes: view.unlocked ? view.notes : null,
                        mission: s.missions.find((m) => m.id === s.activeMission)?.name ?? null,
                        withSessions: msg.withSessions === true
                    }) });
                    break;
                }
                case "rec-read": reply({ t: "rec-cast", name: String(msg.name), cast: recorder.read(msg.name) }); break;
                case "rec-open": {
                    mkdirSync(RECORDINGS, { recursive: true });
                    openFolder(RECORDINGS);
                    break;
                }
                case "kube-use": await status.useKube({ context: msg.context, namespace: msg.namespace }); reply({ t: "kube-used" }); break;
                case "git-list": reply({ t: "git-list", ...status.listRepos() }); break;
                case "git-select": await status.selectRepo(String(msg.repo)); break;
                // Réglages (espace admin) : enregistrés, puis renvoyés à toutes les pages
                case "settings-save": {
                    // Vérifiés d'abord (rubriques : le deck doit tenir sur l'accueil), enregistrés ensuite
                    const next = withActiveMission(settings.check(msg.settings));
                    const current = settings.get();
                    const worldsChanged = JSON.stringify([next.worlds, next.worldOrder]) !== JSON.stringify([current.worlds, current.worldOrder]);
                    const nextDeck = worldsChanged ? makeDeck(next.worlds, next.worldOrder) : deck;
                    broadcast({ t: "settings", settings: settings.save(next) });
                    if (worldsChanged) { deck = nextDeck; broadcast(deckMessage()); }
                    reply({ t: "vault-ok", text: "réglages enregistrés", close: false });
                    break;
                }
                // Coffre (notes et secrets chiffrés)
                case "vault-create": await vault.create(msg.password); break;
                case "vault-unlock": await vault.unlock(msg.password); break;
                case "vault-lock": vault.lock("verrouillé"); break;
                case "vault-password": await vault.changePassword(msg.current, msg.next); reply({ t: "vault-ok", text: "mot de passe maître changé" }); break;
                case "vault-export": reply({ t: "vault-export", data: vault.exportBox() }); break;
                case "vault-import": reply({ t: "vault-imported", mode: msg.mode, ...(await vault.importBox(msg.data, String(msg.mode), msg.password)) }); break;
                case "note-save": reply({ t: "note-saved", id: vault.saveNote({ id: msg.id, title: msg.title, body: msg.body, color: msg.color }), req: msg.req }); break;
                case "note-delete": vault.deleteNote(String(msg.id)); break;
                case "note-done": vault.setNoteDone(String(msg.id), msg.done); break;
                case "secret-save": vault.saveSecret(msg); reply({ t: "vault-ok", text: "secret enregistré", close: true }); break;
                case "secret-delete": vault.deleteSecret(String(msg.id)); break;
                // La valeur n'est envoyée qu'à la page qui la demande (copier / afficher)
                case "secret-reveal": reply({ t: "secret-value", id: String(msg.id), value: vault.secretValue(String(msg.id)), purpose: msg.purpose }); break;
                // Copier : presse-papiers du système, écrit côté serveur (la valeur ne passe pas par la page), effacé après 30 s
                case "secret-copy":
                    await copyTemporarily(vault.secretValue(String(msg.id)), 30);
                    reply({ t: "vault-ok", text: "copié : effacé du presse-papiers dans 30 s" });
                    break;
                // Taper dans le terminal : écrit côté serveur, la valeur ne passe pas par la page
                case "secret-type": {
                    if (!terminals.sessions.has(String(msg.sid))) throw new Error("aucun terminal actif");
                    terminals.write(String(msg.sid), vault.secretValue(String(msg.id)));
                    reply({ t: "vault-ok", text: "secret tapé dans le terminal (sans Entrée)" });
                    break;
                }
                // Favoris : modifiés depuis la page, puis deck reconstruit et renvoyé à toutes les pages
                case "fav-add":
                case "fav-update":
                case "fav-remove":
                case "fav-move":
                case "fav-place": {
                    const def = { kind: msg.kind, label: msg.label, url: msg.url, icon: msg.icon, color: msg.color, ...("parent" in msg ? { parent: msg.parent } : {}) };
                    if (msg.t === "fav-add") favorites.add(def);
                    if (msg.t === "fav-update") favorites.update(String(msg.id), def);
                    if (msg.t === "fav-remove") favorites.remove(String(msg.id));
                    if (msg.t === "fav-move") favorites.move(String(msg.id), msg.delta);
                    if (msg.t === "fav-place") favorites.place(String(msg.id), msg.parent ?? null, msg.before ?? null);
                    deck = makeDeck();
                    broadcast(deckMessage());
                    reply({ t: "fav-saved" });
                    break;
                }
                // Export / import des favoris (Réglages) : pour les retrouver sur une autre machine
                // Sauvegardes automatiques (Réglages) : liste et restauration (la version actuelle est sauvegardée avant)
                // Redémarrage demandé depuis les Réglages (terminaux rouverts au démarrage suivant)
                case "restart": restart(); break;
                // Paramètres nommés : valeurs réelles (kubectl / docker) proposées dans la fenêtre de saisie
                case "param-options": {
                    try {
                        reply({ t: "param-options", req: msg.req, name: msg.name, options: await paramOptions(ctx, msg.name, { namespace: msg.namespace, service: msg.service }) });
                    } catch (err) {
                        reply({ t: "param-options", req: msg.req, name: msg.name, options: [], error: err.message.split("\n")[0] });
                    }
                    break;
                }
                // Signature en bannière ASCII (FIGlet) : dessinée ici, affichée en filigrane par la page
                case "banner": {
                    const text = String(msg.text ?? "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 60);
                    const font = settings.check({ watermarkFont: msg.font }).watermarkFont;
                    const art = text ? figlet.textSync(text, { font }).replace(/\s+$/, "") : "";
                    reply({ t: "banner", key: `${text}|${font}`, art });
                    break;
                }
                // Journal : touche « text » ou lien (envoyé par la page), liste, export CSV, effacement
                case "journal": logAction({ label: msg.label, page: msg.page, command: msg.command, mode: msg.mode }, msg.sid); break;
                case "journal-list": reply({ t: "journal-list", entries: journal.recent(200) }); break;
                // Palette ⌘K : commandes récentes (dédoublonnées côté page)
                case "journal-recent": reply({ t: "journal-recent", entries: journal.recent(300) }); break;
                case "journal-export": reply({ t: "journal-export", csv: journal.csv() }); break;
                case "journal-clear": journal.clear(); reply({ t: "journal-list", entries: [] }); break;
                case "update-check": reply({ t: "update", ...(await updater.check()) }); break;
                case "update-apply": {
                    broadcast({ t: "update-progress", text: "mise à jour en cours (git pull, dépendances)…" });
                    const v = await updater.apply();
                    console.log(`Mise à jour appliquée depuis la page : version ${v.version}`);
                    broadcast({ t: "update-progress", text: `version ${v.version} installée : redémarrage…` });
                    restart();
                    break;
                }
                // Missions : enregistrer (rubriques actuelles reprises si demandé), supprimer, activer
                // Mes actions : rubriques et touches créées depuis les Réglages (actions.json, hors Git)
                case "action-section-save":
                case "action-section-import":
                case "action-section-delete":
                case "action-save":
                case "action-delete":
                case "action-move": {
                    let created = null;
                    const before = actions.list();   // pour revenir en arrière si l'accueil déborde (action épinglée)
                    if (msg.t === "action-section-save") {
                        const isNew = !msg.section?.id;
                        const id = actions.saveSection(msg.section);
                        if (isNew) created = id;
                    }
                    if (msg.t === "action-section-import") created = actions.importSection(msg.section);
                    if (msg.t === "action-section-delete") {
                        actions.deleteSection(String(msg.id));
                        const s = settings.get();
                        const { [msg.id]: _removed, ...worlds } = s.worlds;
                        updateSettings({ worlds, worldOrder: s.worldOrder.filter((w) => w !== msg.id) });
                    }
                    if (msg.t === "action-save") actions.saveAction(String(msg.section), msg.action);
                    if (msg.t === "action-delete") actions.deleteAction(String(msg.section), String(msg.id));
                    if (msg.t === "action-move") actions.moveAction(String(msg.section), String(msg.id), msg.delta);
                    // Nouvelle rubrique : affichée sur l'accueil si elle y tient (18 touches au plus)
                    let shown = true;
                    if (created) {
                        const worlds = { ...settings.get().worlds, [created]: true };
                        try { deck = makeDeck(worlds); updateSettings({ worlds }); } catch { shown = false; deck = makeDeck(); }
                    } else {
                        try {
                            deck = makeDeck();
                        } catch (err) {
                            actions.sections = before;
                            actions.save();
                            throw new Error(`${err.message} Pour épingler cette action, décoche une rubrique (Réglages › Rubriques) ou retire une autre action de l'accueil.`);
                        }
                    }
                    broadcast({ t: "settings", settings: settings.get() });
                    broadcast({ t: "actions", sections: actions.list() });
                    broadcast(deckMessage());
                    reply({ t: "action-saved", created, shown });
                    break;
                }
                case "mission-save": {
                    const s = settings.get();
                    const input = msg.mission ?? {};
                    const id = input.id || `m-${randomBytes(4).toString("hex")}`;
                    const old = s.missions.find((m) => m.id === id);
                    if (input.workspace && !existsSync(String(input.workspace))) throw new Error(`dossier introuvable : ${input.workspace}`);
                    const mission = {
                        ...old, ...input, id,
                        ...(input.captureWorlds || !old ? { worlds: s.worlds, worldOrder: s.worldOrder } : {})
                    };
                    delete mission.captureWorlds;
                    const missions = old ? s.missions.map((m) => (m.id === id ? mission : m)) : [...s.missions, mission];
                    settings.update({ missions });
                    if (s.activeMission === id) activateMission(id);
                    else broadcast({ t: "settings", settings: settings.get() });
                    reply({ t: "mission-saved", name: mission.name });
                    break;
                }
                case "mission-delete": {
                    const s = settings.get();
                    settings.update({ missions: s.missions.filter((m) => m.id !== msg.id), activeMission: s.activeMission === msg.id ? "" : s.activeMission });
                    applyMissionEffects();
                    broadcast({ t: "settings", settings: settings.get() });
                    break;
                }
                case "mission-activate": {
                    const m = activateMission(String(msg.id ?? ""));
                    reply({ t: "vault-ok", text: m ? `mission « ${m.name} » activée` : "aucune mission active", close: false });
                    break;
                }
                // Nouveau jeton : l'ancien ne vaut plus rien. La page qui le demande bascule sur le nouveau ;
                // les autres connexions sont fermées (celles du même navigateur reviennent avec le cookie mis à jour).
                case "token-renew": {
                    token = randomBytes(32).toString("hex");
                    writeFileSync(path.join(ROOT, ".deck-token"), token, { mode: 0o600 });
                    console.log(`Jeton d'accès renouvelé depuis la page : ${deckUrlFor()}`);
                    reply({ t: "token-renewed", token });
                    for (const client of wss.clients) {
                        if (client === ws) continue;
                        client.send(JSON.stringify({ t: "token-revoked" }));
                        client.close(4001, "jeton renouvelé");
                    }
                    break;
                }
                case "diagnostic":
                    reply({ t: "diagnostic", checks: await runDiagnostic({ ctx, remote, tools, backups, supervisor: SUPERVISOR, localUnix: LOCAL_UNIX, deckTools, root: ROOT }) });
                    break;
                // Signature en image : PNG uniquement (vérifié à ses premiers octets), 600 Ko au plus
                case "signature-upload": {
                    const data = Buffer.from(String(msg.data ?? ""), "base64");
                    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
                    if (!data.subarray(0, 8).equals(PNG)) throw new Error("l'image doit être un PNG (de préférence sur fond transparent)");
                    if (data.length > MAX_SIGNATURE_BYTES) throw new Error("image trop lourde (600 Ko au plus)");
                    writeFileSync(SIGNATURE_FILE, data, { mode: 0o600 });
                    broadcast({ t: "signature", version: signatureVersion() });
                    reply({ t: "vault-ok", text: "image de signature enregistrée", close: false });
                    break;
                }
                case "signature-remove":
                    if (existsSync(SIGNATURE_FILE)) unlinkSync(SIGNATURE_FILE);
                    broadcast({ t: "signature", version: null });
                    break;
                case "tools-check":
                    if (msg.watch) watchTools();
                    await checkTools();
                    reply({ t: "tools", ...tools.view() });
                    break;
                case "backup-list": reply({ t: "backup-list", backups: backups.all() }); break;
                case "backup-restore": {
                    const name = String(msg.name);
                    if (name === "favoris.json") {
                        backups.restore(favorites.file, String(msg.id));
                        favorites.reload();
                        deck = makeDeck();
                        broadcast(deckMessage());
                    } else if (name === "settings.json") {
                        backups.restore(settings.file, String(msg.id));
                        settings.reload();
                        try { deck = makeDeck(); } catch (err) { deck = makeDeck({}, []); console.warn(`  Rubriques des Réglages ignorées : ${err.message}`); }
                        broadcast({ t: "settings", settings: settings.get() });
                        broadcast(deckMessage());
                    } else if (name === "actions.json") {
                        backups.restore(actions.file, String(msg.id));
                        actions.reload();
                        deck = makeDeck();
                        broadcast({ t: "actions", sections: actions.list() });
                        broadcast(deckMessage());
                    } else if (name === "vault.enc") {
                        vault.lock("restauré");
                        backups.restore(vault.file, String(msg.id));
                        vault.emit("change", "restauré");
                    } else {
                        throw new Error("fichier inconnu");
                    }
                    reply({ t: "backup-restored", name, backups: backups.all() });
                    break;
                }
                case "fav-export": reply({ t: "fav-export", data: favorites.export() }); break;
                // Configuration complète (autre machine) : favoris, Mes actions, réglages et missions, signature.
                // Le coffre a son propre export (son import demande le mot de passe maître).
                case "config-export": {
                    reply({ t: "config-export", data: {
                        app: "web-deck-devsecops", kind: "configuration", version: 1, exported: new Date().toISOString(),
                        from: { machine: os.hostname(), platform },
                        favorites: favorites.dump(),
                        actions: actions.list(),
                        settings: settings.get(),
                        signature: existsSync(SIGNATURE_FILE) ? readFileSync(SIGNATURE_FILE).toString("base64") : null
                    } });
                    break;
                }
                case "config-import": {
                    const data = msg.data;
                    if (data?.kind !== "configuration") throw new Error("fichier non reconnu : ce n'est pas un export de configuration du deck");
                    const parts = msg.parts ?? {};
                    const done = [];
                    const warnings = [];
                    if (parts.actions && Array.isArray(data.actions)) {
                        backups.before(actions.file, { force: true });
                        writeFileSync(actions.file, `${JSON.stringify({ sections: data.actions }, null, 2)}\n`);
                        actions.reload();
                        done.push(`Mes actions (${actions.list().length} rubrique(s))`);
                    }
                    if (parts.favorites && Array.isArray(data.favorites)) {
                        const stats = favorites.import(data.favorites, parts.favoritesMode === "replace" ? "replace" : "merge");
                        done.push(`favoris (${stats.added} ajouté(s))`);
                    }
                    if (parts.settings && data.settings && typeof data.settings === "object") {
                        const next = settings.check(data.settings);   // validé champ par champ, tout ou rien
                        let checkedDeck;
                        try { checkedDeck = makeDeck(next.worlds, next.worldOrder); } catch (err) { warnings.push(`rubriques : ${err.message} (celles de config.jsonc gardées)`); next.worlds = {}; next.worldOrder = []; }
                        backups.before(settings.file, { force: true });
                        settings.save(next);
                        if (checkedDeck) deck = checkedDeck;
                        const missing = next.missions.filter((m) => m.workspace && !existsSync(m.workspace)).map((m) => `${m.name} (${m.workspace})`);
                        if (missing.length) warnings.push(`dossier introuvable sur cette machine pour : ${missing.join(", ")} ; à corriger dans Réglages › Missions`);
                        applyMissionEffects();
                        done.push(`réglages et ${next.missions.length} mission(s)`);
                    }
                    if (parts.signature && typeof data.signature === "string") {
                        const png = Buffer.from(data.signature, "base64");
                        if (png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && png.length <= MAX_SIGNATURE_BYTES) {
                            writeFileSync(SIGNATURE_FILE, png, { mode: 0o600 });
                            broadcast({ t: "signature", version: signatureVersion() });
                            done.push("signature");
                        } else {
                            warnings.push("signature ignorée (image invalide)");
                        }
                    }
                    try { deck = makeDeck(); } catch (err) { deck = makeDeck({}, []); warnings.push(`accueil : ${err.message} (rubriques de config.jsonc affichées)`); }
                    broadcast({ t: "settings", settings: settings.get() });
                    broadcast({ t: "actions", sections: actions.list() });
                    broadcast(deckMessage());
                    reply({ t: "config-imported", done, warnings });
                    break;
                }
                case "fav-import": {
                    const stats = favorites.import(msg.data, msg.mode === "replace" ? "replace" : "merge");
                    deck = makeDeck();
                    broadcast(deckMessage());
                    reply({ t: "fav-imported", mode: msg.mode, ...stats });
                    break;
                }
                case "in": terminals.write(String(msg.sid), String(msg.d)); break;
                case "resize": terminals.resize(String(msg.sid), msg.cols, msg.rows); break;
                case "close": terminals.close(String(msg.sid)); break;
                case "rename": {
                    const title = terminals.rename(String(msg.sid), msg.title);
                    if (title !== undefined) broadcast({ t: "renamed", sid: String(msg.sid), title });
                    break;
                }
                case "move": broadcast({ t: "order", order: terminals.move(String(msg.sid), msg.before == null ? null : String(msg.before)) }); break;
                case "press": await status.press(String(msg.id)); break;
                case "run": {
                    // Seules les commandes du catalogue sont lancées : le navigateur n'envoie qu'un identifiant
                    const key = deck.index.get(String(msg.id));
                    if (key?.type !== "run") return reply({ t: "ran", id: msg.id, ok: false, error: "touche inconnue" });
                    await launch(key.command);
                    logAction({ label: key.label, page: String(msg.id).split("/")[0], command: key.command.join(" "), mode: "run" });
                    reply({ t: "ran", id: msg.id, ok: true });
                    break;
                }
            }
        } catch (err) {
            reply({ t: msg.t === "run" ? "ran" : "error", id: msg.id, ok: false, error: err.message.split("\n")[0] });
            console.warn(`  ${msg.t} : ${err.message}`);
        }
    });

    ws.on("close", () => {
        if (wss.clients.size === 0) status.stop();
    });
});

// ---------- Démarrage ----------

const RESTARTING = process.argv.includes("--restarting");
const SUPERVISOR = process.env.DECK_SUPERVISOR || null;
const LOG_FILE = path.join(ROOT, ".deck.log");
const RESTART_EXIT_CODE = 75;   // « relance-moi » pour le service (launchd : KeepAlive si la sortie n'est pas un succès)
let listenTries = 0;

/**
 * Journal trop gros (plus de 1 Mo) : copié en .1 (le précédent est remplacé) puis vidé. Vidé plutôt que renommé :
 * le service (launchd) garde le fichier ouvert en ajout, ses écritures repartent ainsi du début.
 */
function rotateLog(file) {
    try {
        if (!existsSync(file) || statSync(file).size < 1024 * 1024) return;
        copyFileSync(file, `${file}.1`);
        truncateSync(file, 0);
    } catch { /* journal occupé ou illisible : on laisse tel quel */ }
}
// Service macOS : journal ~/Library/Logs ; sous Windows, la boucle du service s'en charge avant chaque lancement
if (SUPERVISOR === "launchd") rotateLog(path.join(os.homedir(), "Library", "Logs", "web-deck-devsecops.log"));

server.on("error", (err) => {
    // Relancé par Redémarrer : l'ancien serveur libère le port dans la seconde, on réessaie jusqu'à 15 s
    if (err.code === "EADDRINUSE" && RESTARTING && ++listenTries < 50) {
        setTimeout(() => server.listen(port, HOST), 300);
        return;
    }
    if (err.code === "EADDRINUSE") {
        // Déjà lancé (double-clic sur le lanceur) : on ouvre simplement la page
        console.log(`Le deck tourne déjà sur le port ${port} : ouverture du navigateur.`);
        if (!process.argv.includes("--no-open")) openBrowser(deckUrl);
        setTimeout(() => process.exit(0), 500);
        return;
    }
    throw err;
});

server.listen(port, HOST, () => {
    checkTools();
    console.log(`${new Date().toLocaleString("fr-FR")}${RESTARTING ? " (redémarrage)" : ""}${SUPERVISOR ? ` [service ${SUPERVISOR}]` : ""}`);
    console.log(`Deck DevSecOps (${ctx.machine}${ctx.machineFile ? `, ${ctx.machineFile}` : ""})`);
    console.log(`  Shells     : ${ctx.shells.map((s) => s.name).join(", ") || "aucun !"}`);
    console.log(`  Workspace  : ${ctx.workspace}`);
    if (restored) console.log(`  Terminaux  : ${restored} rouvert(s) depuis la dernière fois`);
    const missing = Object.entries(ctx.apps).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) console.log(`  Introuvables : ${missing.join(", ")} (voir paths.json)`);
    if (deck.skipped.length) console.log(`  Non disponibles ici : ${deck.skipped.join(", ")}`);
    console.log(`\n  ${deckUrl}\n`);
    console.log(SUPERVISOR ? "Lancé en service : redémarre tout seul s'il s'arrête." : "Ctrl+C pour arrêter (ferme aussi les terminaux).");
    if (!process.argv.includes("--no-open") && !RESTARTING) openBrowser(deckUrl);
});

/**
 * Redémarrage depuis la page : en service, sortie avec RESTART_EXIT_CODE (le service relance) ; lancé à la main,
 * une nouvelle copie détachée est démarrée (journal .deck.log), qui attend que ce serveur libère le port.
 */
function restart() {
    broadcast({ t: "restarting" });
    console.log("Redémarrage demandé depuis la page…");
    setTimeout(async () => {
        await Promise.race([flushClipboard().catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
        remote.stop();
        screenLock.stop();
        vault.lock();
        await Promise.all(recorder.sids().map((sid) => recorder.stop(sid)));
        terminals.closeAll();
        server.close();
        if (SUPERVISOR) process.exit(RESTART_EXIT_CODE);
        rotateLog(LOG_FILE);
        const log = openSync(LOG_FILE, "a", 0o600);
        const child = spawn(process.execPath, [process.argv[1], "--no-open", "--restarting"], {
            cwd: ROOT, env: process.env, detached: true, stdio: ["ignore", log, log], windowsHide: true
        });
        child.unref();
        process.exit(0);
    }, 300);
}

/** Arrêt : presse-papiers vidé s'il contient encore un secret copié (au plus 2 s d'attente), puis fermeture. */
async function shutdown() {
    await Promise.race([flushClipboard().catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
    remote.stop();
    screenLock.stop();
    vault.lock();
    await Promise.all(recorder.sids().map((sid) => recorder.stop(sid)));
    terminals.closeAll();
    process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// Windows : fermeture de la fenêtre console (SIGHUP) ; sinon les shells resteraient orphelins
process.on("SIGHUP", shutdown);
