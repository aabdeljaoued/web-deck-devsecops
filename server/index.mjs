// Serveur du deck : page web (grille + terminal), WebSocket pour les terminaux, les voyants et les lanceurs.
// N'écoute que sur 127.0.0.1. Accès protégé par un jeton (cookie), l'en-tête Host et l'origine des WebSockets.
//
//   node server/index.mjs            démarre et ouvre le navigateur
//   node server/index.mjs --no-open  démarre sans ouvrir le navigateur
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer } from "ws";

import { buildDeck, ICONS } from "./catalog.mjs";
import { iconFile } from "./icons.mjs";
import { loadConfig, ROOT } from "./config.mjs";
import { launch, openBrowser, windowsPty } from "./platform.mjs";
import { StatusHub } from "./status.mjs";
import { Terminals } from "./terminal.mjs";

const HOST = "127.0.0.1";
const COOKIE = "deck_token";

const ctx = loadConfig();
const deck = buildDeck(ctx);
const port = ctx.port;
const token = loadToken();
const deckUrl = `http://${HOST}:${port}/?token=${token}`;

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
    const entry = req.method === "GET" && STATIC[url.pathname];
    if (!entry) return send(res, 404, "Introuvable");
    send(res, 200, readFileSync(entry[0]), entry[1]);
});

// ---------- WebSocket : terminaux, voyants, lanceurs ----------

const terminals = new Terminals(ctx, path.join(ROOT, ".deck-sessions.json"));
const status = new StatusHub(ctx);
const restored = terminals.restore();
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
status.on("update", (id, state) => broadcast({ t: "status", id, state }));

wss.on("connection", (ws) => {
    status.start();
    ws.send(JSON.stringify({
        t: "hello",
        pages: deck.pages,
        titles: deck.titles,
        shells: ctx.shells.map(({ name, kind }) => ({ name, kind })),
        windowsPty: windowsPty(),
        sessions: terminals.list(),
        status: status.states
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

server.on("error", (err) => {
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
    console.log(`Deck DevSecOps (${ctx.machine}${ctx.machineFile ? `, ${ctx.machineFile}` : ""})`);
    console.log(`  Shells     : ${ctx.shells.map((s) => s.name).join(", ") || "aucun !"}`);
    console.log(`  Workspace  : ${ctx.workspace}`);
    if (restored) console.log(`  Terminaux  : ${restored} rouvert(s) depuis la dernière fois`);
    const missing = Object.entries(ctx.apps).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) console.log(`  Introuvables : ${missing.join(", ")} (voir paths.json)`);
    if (deck.skipped.length) console.log(`  Non disponibles ici : ${deck.skipped.join(", ")}`);
    console.log(`\n  ${deckUrl}\n`);
    console.log("Ctrl+C pour arrêter (ferme aussi les terminaux).");
    if (!process.argv.includes("--no-open")) openBrowser(deckUrl);
});

function shutdown() {
    terminals.closeAll();
    process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// Windows : fermeture de la fenêtre console (SIGHUP) ; sinon les shells resteraient orphelins
process.on("SIGHUP", shutdown);
