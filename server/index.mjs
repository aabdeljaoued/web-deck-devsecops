// Serveur du deck : page web (grille + terminal), WebSocket pour les terminaux, les voyants et les lanceurs.
// N'écoute que sur 127.0.0.1. Accès protégé par un jeton (cookie), l'en-tête Host et l'origine des WebSockets.
//
//   node server/index.mjs            démarre et ouvre le navigateur
//   node server/index.mjs --no-open  démarre sans ouvrir le navigateur
//   --restarting                     relancé par le bouton Redémarrer : attend que le port se libère
// DECK_SUPERVISOR=launchd|windows : lancé en service (service/), qui le relance s'il s'arrête sur un code ≠ 0.
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { copyFileSync, existsSync, openSync, readFileSync, statSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { WebSocketServer } from "ws";

import { buildDeck, ICONS } from "./catalog.mjs";
import { Backups } from "./backups.mjs";
import { copyTemporarily, flushClipboard } from "./clipboard.mjs";
import { ScreenLock } from "./screenlock.mjs";
import { runDiagnostic } from "./diagnostic.mjs";
import { Favorites } from "./favorites.mjs";
import { Vault } from "./vault.mjs";
import { Settings } from "./settings.mjs";
import { iconFile } from "./icons.mjs";
import { loadConfig, ROOT } from "./config.mjs";
import { launch, openBrowser, platform, windowsPty } from "./platform.mjs";
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
/** Deck avec les favoris et les rubriques choisies dans les Réglages. */
const makeDeck = (worlds = settings.get().worlds, order = settings.get().worldOrder) => buildDeck(ctx, favorites.list(), worlds, order);
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

terminals.on("output", (sid, d) => broadcast({ t: "out", sid, d }));
terminals.on("exit", (sid, code) => broadcast({ t: "exit", sid, code }));

// Terminaux connectés en ssh / wsl : active les rubriques qui demandent un shell Linux / macOS (Ansible sous Windows).
// DECK_LOCAL_UNIX=0 : se comporter comme sous Windows (pour tester sur un Mac).
const LOCAL_UNIX = platform !== "windows" && process.env.DECK_LOCAL_UNIX !== "0";
const remote = new RemoteWatch(terminals);
remote.on("change", (state) => broadcast({ t: "remote", remote: state }));
remote.start();

// Session verrouillée (écran de verrouillage) : le coffre se verrouille aussitôt
const screenLock = new ScreenLock(remote);
screenLock.on("change", (locked) => { if (locked) vault.lock("écran verrouillé"); });
screenLock.start();
status.on("update", (id, state) => broadcast({ t: "status", id, state }));
// Coffre : état et contenu (secrets sans leur valeur) renvoyés à toutes les pages à chaque changement
vault.on("change", (reason) => broadcast({ t: "vault", ...vault.view(), ...(reason ? { reason } : {}) }));

wss.on("connection", (ws) => {
    status.start();
    ws.send(JSON.stringify({
        t: "hello",
        pages: deck.pages,
        titles: deck.titles,
        parents: deck.parents,
        favGroups: favorites.groups(),
        worlds: deck.worlds,
        tools: tools.view(),
        localUnix: LOCAL_UNIX,
        signature: signatureVersion(),
        remote: remote.view(),
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
                case "kube-use": await status.useKube({ context: msg.context, namespace: msg.namespace }); reply({ t: "kube-used" }); break;
                case "git-list": reply({ t: "git-list", ...status.listRepos() }); break;
                case "git-select": await status.selectRepo(String(msg.repo)); break;
                // Réglages (espace admin) : enregistrés, puis renvoyés à toutes les pages
                case "settings-save": {
                    // Vérifiés d'abord (rubriques : le deck doit tenir sur l'accueil), enregistrés ensuite
                    const next = settings.check(msg.settings);
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
                    reply({ t: "diagnostic", checks: await runDiagnostic({ ctx, remote, tools, backups, supervisor: SUPERVISOR, localUnix: LOCAL_UNIX, deckTools }) });
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
    terminals.closeAll();
    process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// Windows : fermeture de la fenêtre console (SIGHUP) ; sinon les shells resteraient orphelins
process.on("SIGHUP", shutdown);
