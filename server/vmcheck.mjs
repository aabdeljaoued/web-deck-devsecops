// Vérification d'une VM (bouton « Vérifier » de l'inventaire des patchs) : connexion ssh non interactive et
// commandes en LECTURE SEULE (simulation de mise à jour, fichiers d'état) : rien n'est installé ni modifié.
// - BatchMode : aucune question (mot de passe, clé d'hôte inconnue) ; la VM doit déjà être connue de ~/.ssh/known_hosts
//   et accepter la clé : le deck n'accepte jamais une clé d'hôte à ta place.
// - ssh lancé sans shell local (execFile), hôte après « -- » : pas d'injection d'option ou de commande.
// - Le script part sur l'entrée standard de « sh -s » : il ne dépend pas du shell de connexion de la VM.
import { spawn } from "node:child_process";
import os from "node:os";

const TIMEOUT_MS = 90 * 1000;

/** Script envoyé à la VM (sh POSIX) : une ligne CLE=valeur par information. */
export const CHECK_SCRIPT = String.raw`
LC_ALL=C; export LC_ALL
[ -r /etc/os-release ] && . /etc/os-release
[ -n "$PRETTY_NAME" ] || PRETTY_NAME=$(uname -s)
echo "OS=$PRETTY_NAME"
echo "KERNEL=$(uname -r)"
[ -r /proc/uptime ] && echo "UPTIME=$(cut -d. -f1 /proc/uptime)"
U=""; S=""; M=""
if command -v apt-get >/dev/null 2>&1; then
    M=apt
    SIM=$(apt-get -s -o Debug::NoLocking=1 upgrade 2>/dev/null | grep '^Inst ')
    U=$(printf '%s\n' "$SIM" | grep -c '^Inst ')
    S=$(printf '%s\n' "$SIM" | grep -ci 'securi')
elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
    M=dnf; command -v dnf >/dev/null 2>&1 || M=yum
    U=$($M -q check-update 2>/dev/null | grep -cE '^[[:alnum:]_.+-]+\.[[:alnum:]_]+[[:space:]]')
    S=$($M -q check-update --security 2>/dev/null | grep -cE '^[[:alnum:]_.+-]+\.[[:alnum:]_]+[[:space:]]')
elif command -v zypper >/dev/null 2>&1; then
    M=zypper
    U=$(zypper -q --non-interactive lu 2>/dev/null | grep -c '^v ')
elif command -v apk >/dev/null 2>&1; then
    M=apk
    U=$(apk -u list 2>/dev/null | grep -c .)
fi
echo "MANAGER=$M"; echo "UPDATES=$U"; echo "SECURITY=$S"
R=0
if [ -f /var/run/reboot-required ]; then R=1
elif command -v needs-restarting >/dev/null 2>&1; then needs-restarting -r >/dev/null 2>&1; [ $? -eq 1 ] && R=1
elif command -v rpm >/dev/null 2>&1; then
    rpm -q kernel >/dev/null 2>&1 && LATEST=$(rpm -q --qf '%{VERSION}-%{RELEASE}.%{ARCH}\n' kernel 2>/dev/null | sort -V | tail -1)
    [ -n "$LATEST" ] && [ "$LATEST" != "$(uname -r)" ] && R=1
fi
echo "REBOOT=$R"
echo "END=ok"
`;

/** Sortie du script -> résultat ; null si la sortie n'est pas celle attendue (VM non Linux…). */
export function parseCheck(stdout, at = new Date()) {
    const kv = Object.fromEntries(String(stdout).split(/\r?\n/).map((l) => l.match(/^([A-Z]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim()]));
    if (kv.END !== "ok") return null;
    const num = (v) => (v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
    const up = num(kv.UPTIME);
    return { at: at.toISOString(), os: kv.OS ?? "", kernel: kv.KERNEL ?? "", uptimeDays: up === null ? null : Math.floor(up / 86400),
        manager: kv.MANAGER ?? "", updates: num(kv.UPDATES), security: ["zypper", "apk"].includes(kv.MANAGER) ? null : num(kv.SECURITY), reboot: kv.REBOOT === "1" };
}

/** Message d'erreur ssh en clair (les plus courants). */
export function sshError(stderr, code) {
    const s = String(stderr ?? "");
    if (/Host key verification failed|No .*host key is known/i.test(s)) return "clé d'hôte inconnue : connecte-toi une première fois avec la touche SSH pour l'accepter";
    if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(s)) return "la clé d'hôte a changé : vérifie avant de te reconnecter";
    if (/Permission denied/i.test(s)) return "connexion refusée : clé SSH absente ou refusée (le deck ne tape jamais de mot de passe)";
    if (/Could not resolve hostname/i.test(s)) return "nom d'hôte inconnu (DNS)";
    if (/timed out|Connection timed out/i.test(s)) return "délai dépassé : VM injoignable";
    if (/Connection refused/i.test(s)) return "connexion refusée (port 22 fermé ?)";
    if (/sh: .*not found|is not recognized|CommandNotFound/i.test(s)) return "VM non Linux : vérification disponible pour Linux seulement";
    const last = s.trim().split(/\r?\n/).filter(Boolean).at(-1);
    return last ? last.slice(0, 200) : `ssh a échoué (code ${code})`;
}

/** Arguments de ssh pour une VM (clé ~ développée, pas de shell local). */
export function sshArgs(vm) {
    const target = vm.host || vm.name;
    if (!/^[A-Za-z0-9_.@:-]+$/.test(target) || target.startsWith("-")) throw new Error(`hôte invalide : ${target}`);
    const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15"];
    if (vm.identity) args.push("-i", vm.identity.replace(/^~(?=$|[\\/])/, os.homedir()), "-o", "IdentitiesOnly=yes");
    args.push("--", target, "sh", "-s");
    return args;
}

/** Vérifie une VM ; résout toujours (résultat ou { at, error }). */
export function checkVm(vm, { ssh = "ssh", timeout = TIMEOUT_MS } = {}) {
    return new Promise((resolve) => {
        const at = new Date();
        let args;
        try { args = sshArgs(vm); } catch (err) { resolve({ at: at.toISOString(), error: err.message }); return; }
        let out = "", err = "", done = false;
        const child = spawn(ssh, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
        const timer = setTimeout(() => { child.kill(); finish({ at: at.toISOString(), error: "délai dépassé (90 s)" }); }, timeout);
        child.stdout.on("data", (d) => { if (out.length < 100000) out += d; });
        child.stderr.on("data", (d) => { if (err.length < 20000) err += d; });
        child.on("error", (e) => finish({ at: at.toISOString(), error: e.code === "ENOENT" ? "commande ssh introuvable (client OpenSSH à installer)" : e.message }));
        child.on("close", (code) => {
            const parsed = parseCheck(out, at);
            finish(parsed ?? { at: at.toISOString(), error: sshError(err || out, code) });
        });
        child.stdin.on("error", () => {});
        child.stdin.end(CHECK_SCRIPT);
    });
}
