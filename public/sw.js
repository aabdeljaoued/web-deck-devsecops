// Service worker de l'application installée (PWA) : rien n'est mis en cache (le deck est local et ses pages
// dépendent du jeton) ; il sert seulement à rendre le deck installable et à afficher un message clair quand le
// serveur local ne répond pas (service arrêté).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

const OFFLINE = `<!doctype html><html lang="fr"><meta charset="utf-8"><title>Deck DevSecOps</title>
<body style="margin:0;display:grid;place-items:center;height:100vh;background:#071226;color:#e6edf6;font-family:system-ui,sans-serif;text-align:center">
<div><h1 style="font-size:22px">Le serveur du deck ne répond pas</h1>
<p>Le service local est arrêté ou redémarre.<br>Relance-le (service\\installer.cmd sous Windows, service/installer.command sous macOS),<br>puis recharge cette fenêtre (Ctrl+R / ⌘R).</p></div></body></html>`;

self.addEventListener("fetch", (event) => {
    if (event.request.mode !== "navigate") return;   // seules les ouvertures de page sont concernées
    event.respondWith(fetch(event.request).catch(() => new Response(OFFLINE, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } })));
});
