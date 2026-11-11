// Catalogue des touches : raccourcis de la page d'accueil et rubriques (dossiers), puis mise en page.
//
// Une commande peut être une chaîne (identique partout) ou { windows: ..., mac: ... } (variante par système).
// Dans une commande à compléter, {} marque où va le texte sélectionné dans le terminal (sinon le curseur y est placé).
// Une touche dont la variante n'existe pas pour le système courant est ignorée.
// Pour les touches qui tapent dans le terminal, une variante peut encore dépendre du shell :
// sh(posix, powershell, cmd) ; la page choisit selon le shell de l'onglet actif.
import { iconFile } from "./icons.mjs";
import { platform } from "./platform.mjs";
import { DESCRIPTIONS } from "./descriptions.mjs";
import { neededTool } from "./tools.mjs";

export const COLORS = {
    git: "#F05032", k8s: "#326CE5", sec: "#C62828", terraform: "#7B42BC", vault: "#FFC107",
    ssh: "#2E7D32", openssl: "#AD1457", docker: "#0898C8", helm: "#1E88E5", vscode: "#007ACC",
    tool: "#37474F", web: "#00897B", danger: "#B71C1C", brew: "#FBB040", ansible: "#5BBDBF", fav: "#9CCC65",
    linux: "#FCC624", patch: "#00838F"
};
const C = COLORS;

const isPlatformMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && ("windows" in v || "mac" in v || "linux" in v);
const pick = (v) => (isPlatformMap(v) ? v[platform] : v);

/**
 * Icône dessinée à la place de l'emoji des touches (le sym reste en secours) :
 * "lucide-<nom>" = jeu d'icônes Lucide (ISC), "<nom>" = public/icons ou logo simple-icons.
 */
const SYM_ICONS = {
    "▶": "lucide-play", "🖥": "lucide-monitor", "🐙": "github", "⚔": "lucide-swords",
    "📂": "lucide-folder-open", "➕": "lucide-plus", "↩": "lucide-undo-2", "📄": "lucide-file-text",
    "±": "lucide-diff", "📁": "lucide-folder-plus", "🧩": "lucide-puzzle", "⬇": "lucide-download",
    "ℹ": "lucide-info", "⚙": "lucide-settings", "⟳": "lucide-refresh-cw", "✍": "lucide-signature",
    "⬆": "lucide-upload", "📥": "lucide-archive", "📤": "lucide-archive-restore", "↺": "lucide-rotate-ccw",
    "✎": "lucide-pencil", "⚡": "lucide-zap", "▦": "lucide-server", "📜": "lucide-scroll-text",
    "🔍": "lucide-search", "🛂": "lucide-user-check", "🧱": "lucide-brick-wall", "📊": "lucide-chart-column",
    "🔎": "lucide-scan-search", "🐳": "lucide-container", "🔑": "lucide-key-round", "✔": "lucide-badge-check",
    "☸": "lucide-ship-wheel", "📦": "lucide-package", "📘": "lucide-book-open", "⚠": "lucide-triangle-alert",
    "📝": "lucide-file-pen-line", "👁": "lucide-eye", "🚀": "lucide-rocket", "🗂": "lucide-folder-tree",
    "⇥": "lucide-arrow-right-to-line", "🔌": "lucide-plug", "💣": "lucide-bomb", "🔐": "lucide-lock-keyhole",
    "🎫": "lucide-ticket", "🧰": "lucide-vault", "👥": "lucide-users", "🌐": "lucide-globe",
    "🧪": "lucide-flask-conical", "⛔": "lucide-ban", "⏰": "lucide-alarm-clock", "📋": "lucide-clipboard",
    "🍃": "lucide-leaf", "🩺": "lucide-stethoscope", "♻": "lucide-recycle", "🗑": "lucide-trash-2",
    "📡": "lucide-radio-tower", "🖼": "lucide-image", "🔨": "lucide-hammer", "🧹": "lucide-brush-cleaning",
    "⎈": "helm", "🕘": "lucide-history", "🗝": "lucide-key", "⇄": "lucide-arrow-left-right",
    "✖": "lucide-x", "📅": "lucide-calendar", "⛓": "lucide-link", "🎲": "lucide-dices",
    "🔒": "lock", "🛡": "lucide-shield",
    // Symboles texte
    "10": "owasp", "</>": "code-editor", "CVE": "lucide-bug", "git": "lucide-list-checks",
    "log": "lucide-git-graph", "br": "lucide-git-branch", "ctx": "lucide-layers", "pod": "lucide-boxes",
    "svc": "lucide-network", "oc": "lucide-circle-user", "crc": "lucide-activity", "SAST": "lucide-file-search",
    "KEV": "lucide-shield-alert", "init": "lucide-power", "fmt": "lucide-wand-sparkles", "ws": "lucide-layout-grid",
    "UI": "lucide-app-window", "ver": "lucide-tag", ">_": "lucide-square-terminal", "FR": "lucide-flag",
    "ps": "lucide-circle-play", "ps-a": "lucide-list", "#": "lucide-hash", "ag": "lucide-key-square",
    "ag+": "lucide-square-plus", "-v": "lucide-text-search", "RSA": "lucide-file-key", "EC": "lucide-file-key-2",
    "CSR": "lucide-file-signature", "p12": "lucide-file-archive"
};
/** Même symbole, sens différent selon la touche : l'icône est choisie d'après le libellé. */
const LABEL_ICONS = { "ici": "lucide-folder-code", "fingerprint": "lucide-fingerprint" };
const withIcon = (key) => {
    const icon = key && !key.icon && (LABEL_ICONS[key.label] ?? SYM_ICONS[key.sym]);
    return icon ? { ...key, icon } : key;
};

/**
 * Variantes par famille de shell : posix (zsh, bash, Git Bash), powershell, cmd.
 * Une variante absente (undefined) : touche indisponible dans ce shell.
 */
const sh = (posix, powershell, cmd) => Object.fromEntries(Object.entries({ posix, powershell, cmd }).filter(([, v]) => v != null));

// ---------- Types de touches ----------
// tool = outil utilisé par la touche, filtrable via excludeTools dans la config.

/** Tape une commande dans le terminal ; enter = l'exécute aussi (pastille verte). */
function text(label, sym, command, enter, color) {
    const cmd = pick(command);
    if (cmd == null) return null;
    const first = typeof cmd === "string" ? cmd : Object.values(cmd)[0];
    return withIcon({ type: "text", label, sym, color, tool: first.split(" ")[0], badge: enter ? "run" : "type", text: cmd, enter });
}

/**
 * Variante à paramètres d'une touche à compléter : utilisée quand rien n'est sélectionné (terminal ou note),
 * elle ouvre la fenêtre Paramètres avec les listes réelles ({namespace}, {pod}, {container}, {image}).
 */
function withPick(key, command) {
    return key && { ...key, pick: command };
}

/** Touche "text" avec une icône précise (outils sans symbole partagé). */
function textIcon(label, sym, command, enter, color, icon) {
    const key = text(label, sym, command, enter, color);
    return key && { ...key, icon };
}

function web(label, sym, url, color = C.web) {
    return withIcon({ type: "web", label, sym, color, url });
}

/** Lance un programme sur la machine (la commande reste côté serveur). */
function run(label, sym, command, color = C.tool, tool) {
    const cmd = pick(command);
    if (!cmd || cmd.some((part) => !part)) return null;
    return withIcon({ type: "run", label, sym, color, tool, command: cmd });
}

/**
 * icon : nom d'un logo affiché à la place de sym, servi par /icons/<nom>.svg :
 * public/icons/<nom>.svg (icônes du projet) sinon simple-icons.
 */
function folder(label, sym, page, color, icon) {
    return { type: "folder", label, sym, color, page, ...(icon ? { icon } : {}) };
}

/**
 * Touche qui agit sur le cluster courant : si le voyant kubectl est en PRODUCTION (prodPattern de config.jsonc),
 * la page demande une confirmation (deuxième clic) en affichant le contexte et le namespace.
 */
const prodGuard = (key) => key && { ...key, prodGuard: true };
/** En production, le premier clic tape d'abord cette commande de comparaison (ce qui va changer). */
const withDiff = (key, diff) => key && { ...key, diff };

/** Logos utilisés par le catalogue : le serveur ne sert que ceux-là. */
// Icônes de l'interface hors touches (palette : notes, secrets, missions)
export const ICONS = new Set(["lucide-notebook-text", "lucide-key-round", "lucide-briefcase", "lucide-history"]);

/** Retour vers la page parente (l'accueil par défaut ; le groupe du dessus dans les favoris). */
function back(page = "root") {
    return { type: "back", label: "Retour", sym: "↩", icon: "lucide-arrow-left", color: "#212121", page };
}

/** Voyant mis à jour en direct par le serveur (server/status.mjs). */
function status(id, label, sym, color, tool) {
    return { type: "status", label, sym, color, tool, status: id };
}

/**
 * Construit le catalogue pour la machine courante.
 * @param ctx résultat de loadConfig()
 */
function buildCatalog(ctx) {
    const { apps, workspace } = ctx;

    // Verrouillage du poste : toujours en bas à droite (pin), sur l'accueil comme dans les dossiers
    const lock = () => {
        const key = run("Verrouiller", "🔒", { windows: ["rundll32.exe", "user32.dll,LockWorkStation"], mac: ["pmset", "displaysleepnow"] }, C.danger);
        return key && { ...key, pin: "4,2", icon: "lock", right: true };
    };
    const openWorkspace = [apps.vscode, workspace];
    const sshConfig = sh("code $HOME/.ssh/config", "code $HOME/.ssh/config", "code %USERPROFILE%\\.ssh\\config");
    const selfSigned = 'openssl req -x509 -newkey rsa:4096 -sha256 -days 365 -nodes -keyout key.pem -out cert.pem -subj "/CN=localhost"';

    const shortcuts = {
        "vscode":      run("VS Code", "</>", openWorkspace, C.vscode, "code"),
        "crc-start":   text("CRC start", "▶", "crc start", true, C.k8s),
        "crc-console": run("OCP console", "🖥", [apps.crc, "console"], C.k8s, "crc"),
        "github":      web("GitHub", "🐙", "https://github.com"),
        "owasp":       web("OWASP Top 10", "10", "https://owasp.org/Top10/"),
        "nvd":         web("NVD / CVE", "CVE", "https://nvd.nist.gov/vuln/search"),
        "mitre":       web("MITRE ATT&CK", "⚔", "https://attack.mitre.org"),
        "lock":        lock(),
        // Voyants
        "kube-status":      status("kube", "kubectl", "☸", C.k8s, "kubectl"),
        "cert-status":      status("certs", "certificats", "🔒", C.openssl),
        "git-status":       status("git", "branche", "git", C.git, "git"),
        "container-status": status("containers", "conteneurs", "🐳", C.docker)
    };

    // Rubriques : 14 touches max, placées dans l'ordre après "Retour".
    // terminal: true -> rubrique qui tape dans le terminal (reçoit la touche "clear").
    const sections = {
        // Un navigateur ne peut pas envoyer de raccourcis clavier à VS Code : on passe par sa CLI
        vscode: { label: "VS Code", sym: "</>", icon: "code-editor", color: C.vscode, terminal: true, keys: [
            run("Ouvrir workspace", "📂", openWorkspace, C.vscode, "code"),
            text("ici", "</>", "code .", true, C.vscode),
            text("nouvelle fenêtre", "➕", "code -n .", true, C.vscode),
            text("même fenêtre", "↩", "code -r .", true, C.vscode),
            text("aller à fichier:ligne", "📄", "code -g ", false, C.vscode),
            text("diff", "±", "code --diff ", false, C.vscode),
            text("ajouter au workspace", "📁", "code -a .", true, C.vscode),
            text("extensions", "🧩", "code --list-extensions --show-versions", true, C.vscode),
            text("installer extension", "⬇", "code --install-extension ", false, C.vscode),
            text("diagnostic", "ℹ", "code --status", true, C.vscode),
            text("éditer ssh config", "⚙", sshConfig, true, C.tool)
        ]},
        git: { label: "Git", sym: "git", icon: "git", color: C.git, terminal: true, keys: [
            text("status", "git", "git status", true, C.git),
            textIcon("lazygit", "lg", "lazygit", true, C.git, "lucide-panels-top-left"),
            text("pull rebase", "⬇", "git pull --rebase", true, C.git),
            text("log graph", "log", "git log --oneline --graph --decorate -20", true, C.git),
            text("diff stat", "±", "git diff --stat", true, C.git),
            // delta : diff lisible (coloration, numéros de ligne), sans changer la config Git
            { ...textIcon("delta", "Δ", "git -c core.pager=delta diff", true, C.git, "lucide-git-compare"), needs: "delta" },
            text("fetch prune", "⟳", "git fetch --all --prune", true, C.git),
            text("commit signé", "✍", 'git commit -S -m "', false, C.git),
            text("push", "⬆", "git push", false, C.git),
            text("branches", "br", "git branch -vv", true, C.git),
            text("stash", "📥", "git stash", true, C.git),
            text("stash pop", "📤", "git stash pop", true, C.git),
            text("nouvelle branche", "➕", "git switch -c ", false, C.git),
            textIcon("gitleaks", "leak", "gitleaks detect --source . -v", true, C.sec, "lucide-key-round"),
            text("restore", "↺", "git restore ", false, C.danger),
            text("amend", "✎", "git commit --amend", false, C.danger)
        ]},
        k8s: { label: "K8s / OCP", sym: "☸", icon: "kubernetes", color: C.k8s, terminal: true, keys: [
            // contexte / ns : même sélecteur que le voyant kubectl (passage en production confirmé par un 2e clic)
            { ...text("contexte / ns", "ctx", "kubectl config get-contexts", true, C.k8s), kubePicker: true },
            text("pods", "pod", "kubectl get pods", true, C.k8s),
            text("events", "⚡", "kubectl get events --sort-by=.lastTimestamp", true, C.k8s),
            text("nodes", "▦", "kubectl get nodes -o wide", true, C.k8s),
            text("svc / ingress", "svc", "kubectl get svc,ingress", true, C.k8s),
            // pick : sans sélection, fenêtre Paramètres avec la liste réelle (namespace puis pod)
            withPick(text("logs -f", "📜", "kubectl logs -f ", false, C.k8s), "kubectl logs -f -n {namespace} {pod}"),
            // stern : logs de tous les pods dont le nom correspond ({} = nom ou expression régulière)
            withPick(textIcon("stern", "st", "stern {} --since 15m", false, C.k8s, "lucide-logs"), "stern -n {namespace} {pod} --since 15m"),
            withPick(text("describe", "🔍", "kubectl describe pod ", false, C.k8s), "kubectl describe pod -n {namespace} {pod}"),
            // port-forward : namespace, service, puis ses ports réels ; port local = même port par défaut
            withPick(textIcon("port-forward", "⇄", "kubectl port-forward ", false, C.k8s, "lucide-arrow-left-right"), "kubectl port-forward -n {namespace} svc/{service} {port}:{port}"),
            // {} = emplacement du pod : texte sélectionné, sinon position du curseur
            prodGuard(withPick(text("exec -it", ">_", "kubectl exec -it {} -- sh", false, C.k8s), "kubectl exec -it -n {namespace} {pod} -- sh")),
            // apply -f : en production, « kubectl diff -f » d'abord, puis la vraie commande au 2e clic
            prodGuard(withDiff(textIcon("apply -f", "apply", "kubectl apply -f ", false, C.k8s, "lucide-file-check"), "kubectl diff -f ")),
            text("RBAC can-i", "🛂", "kubectl auth can-i --list", true, C.sec),
            text("NetPol", "🧱", "kubectl get networkpolicies", true, C.sec),
            // popeye : audit du cluster (ressources mal configurées, inutilisées...) sur le namespace courant
            textIcon("popeye", "pop", "popeye", true, C.sec, "lucide-scan-heart"),
            text("oc whoami", "oc", sh("oc whoami; oc project", "oc whoami; oc project", "oc whoami & oc project"), true, C.k8s),
            shortcuts["crc-console"],
            text("top pods", "📊", "kubectl top pods", true, C.k8s)
        ]},
        sec: { label: "Sécurité", sym: "🛡", icon: "lucide-shield", color: C.sec, terminal: true, keys: [
            text("Trivy repo", "🔎", "trivy fs --scanners vuln,secret,misconfig .", true, C.sec),
            text("Trivy image", "🐳", "trivy image ", false, C.sec),
            text("Gitleaks", "🔑", "gitleaks detect --source . -v", true, C.sec),
            text("Checkov", "✔", "checkov -d .", true, C.sec),
            text("Semgrep SAST", "SAST", "semgrep scan --config auto", true, C.sec),
            text("Trivy K8s", "☸", "trivy k8s --report summary", true, C.sec),
            text("SBOM", "📦", "trivy fs --format cyclonedx -o sbom.json .", true, C.sec),
            // Installations utilisateur, sans droits admin : Scoop sous Windows, Homebrew sous macOS
            text("install outils", "⬇", {
                windows: sh(
                    "scoop install trivy gitleaks; pip install --user checkov semgrep",
                    "scoop install trivy gitleaks; pip install --user checkov semgrep",
                    "scoop install trivy gitleaks & pip install --user checkov semgrep"
                ),
                mac: "brew install trivy gitleaks checkov semgrep",
                linux: "brew install trivy gitleaks checkov semgrep"
            }, false, C.tool),
            web("Cheat Sheets", "📘", "https://cheatsheetseries.owasp.org"),
            web("GH Advisories", "⚠", "https://github.com/advisories"),
            web("CISA KEV", "KEV", "https://www.cisa.gov/known-exploited-vulnerabilities-catalog"),
            lock()
        ]},
        terraform: { label: "Terraform", sym: "TF", icon: "terraform", color: C.terraform, terminal: true, keys: [
            text("init", "init", "terraform init", true, C.terraform),
            text("fmt", "fmt", "terraform fmt -recursive", true, C.terraform),
            text("validate", "✔", "terraform validate", true, C.terraform),
            text("plan", "📝", "terraform plan -out=tfplan", true, C.terraform),
            text("show plan", "👁", "terraform show tfplan", true, C.terraform),
            text("apply plan", "🚀", "terraform apply tfplan", false, C.danger),
            text("state list", "🗂", "terraform state list", true, C.terraform),
            text("output", "⇥", "terraform output", true, C.terraform),
            text("workspaces", "ws", "terraform workspace list", true, C.terraform),
            text("providers", "🔌", "terraform providers", true, C.terraform),
            text("Trivy IaC", "🔎", "trivy config .", true, C.sec),
            text("Checkov TF", "✔", "checkov -d . --framework terraform", true, C.sec),
            text("destroy", "💣", "terraform destroy", false, C.danger)
        ]},
        vault: { label: "Vault", sym: "🔐", icon: "vault", color: C.vault, terminal: true, keys: [
            text("status", "🔐", "vault status", true, C.vault),
            text("login OIDC", "🔑", "vault login -method=oidc", false, C.vault),
            text("token lookup", "🎫", "vault token lookup", true, C.vault),
            text("kv list", "🗂", "vault kv list secret/", true, C.vault),
            text("kv get", "📄", "vault kv get secret/", false, C.vault),
            text("secrets list", "🧰", "vault secrets list", true, C.vault),
            text("auth list", "👥", "vault auth list", true, C.vault),
            text("VAULT_ADDR", "🌐", sh('export VAULT_ADDR="http://127.0.0.1:8200"', '$env:VAULT_ADDR="http://127.0.0.1:8200"', "set VAULT_ADDR=http://127.0.0.1:8200"), false, C.tool),
            text("server -dev", "🧪", "vault server -dev", false, C.tool),
            web("Vault UI", "UI", "http://127.0.0.1:8200/ui"),
            text("revoke token", "⛔", "vault token revoke -self", false, C.danger),
            lock()
        ]},
        // Gestionnaire de paquets sans droits admin : Homebrew (macOS / Linux), Scoop (Windows)
        brew: { label: { windows: "Scoop", mac: "Brew", linux: "Brew" }, sym: { windows: "🍨", mac: "🍺", linux: "🍺" }, icon: { windows: "lucide-ice-cream-cone", mac: "homebrew", linux: "homebrew" }, color: C.brew, terminal: true, keys: [
            text("update", "⟳", { windows: "scoop update", mac: "brew update", linux: "brew update" }, true, C.brew),
            text("outdated", "⏰", { windows: "scoop status", mac: "brew outdated", linux: "brew outdated" }, true, C.brew),
            text("upgrade tout", "⬆", { windows: "scoop update *", mac: "brew upgrade", linux: "brew upgrade" }, false, C.brew),
            text("install", "➕", { windows: "scoop install ", mac: "brew install ", linux: "brew install " }, false, C.brew),
            text("search", "🔍", { windows: "scoop search ", mac: "brew search ", linux: "brew search " }, false, C.brew),
            text("info", "ℹ", { windows: "scoop info ", mac: "brew info ", linux: "brew info " }, false, C.brew),
            text("list", "📋", { windows: "scoop list", mac: "brew list", linux: "brew list" }, true, C.brew),
            text("leaves", "🍃", { mac: "brew leaves", linux: "brew leaves" }, true, C.brew),
            text("services", "⚙", { mac: "brew services list", linux: "brew services list" }, true, C.brew),
            text("doctor", "🩺", { windows: "scoop checkup", mac: "brew doctor", linux: "brew doctor" }, true, C.brew),
            text("Brewfile", "📦", { mac: "brew bundle dump --file=$HOME/Brewfile --force", linux: "brew bundle dump --file=$HOME/Brewfile --force" }, false, C.brew),
            text("cleanup", "♻", { windows: "scoop cleanup *", mac: "brew cleanup", linux: "brew cleanup" }, false, C.brew),
            text("uninstall", "🗑", { windows: "scoop uninstall ", mac: "brew uninstall ", linux: "brew uninstall " }, false, C.danger)
        ]},
        // Ansible ne s'exécute que sous Linux / macOS (pas de nœud de contrôle Windows) : unix = touches actives
        // si le poste est Linux / macOS, sinon seulement quand le terminal actif est connecté en ssh (ou wsl).
        ansible: { label: "Ansible", sym: "A", icon: "ansible", color: C.ansible, terminal: true, unix: true, keys: [
            text("version", "ver", "ansible --version", true, C.ansible),
            text("ping all", "📡", "ansible all -m ping", true, C.ansible),
            text("inventaire", "🗂", "ansible-inventory --graph", true, C.ansible),
            text("playbook", "▶", "ansible-playbook ", false, C.ansible),
            text("check --diff", "🔍", "ansible-playbook --check --diff ", false, C.ansible),
            text("syntax check", "✔", "ansible-playbook --syntax-check ", false, C.ansible),
            text("list tasks", "📋", "ansible-playbook --list-tasks ", false, C.ansible),
            text("ad-hoc shell", ">_", "ansible all -m shell -a \"", false, C.ansible),
            text("ansible-lint", "🔎", "ansible-lint", true, C.sec),
            text("galaxy install", "⬇", "ansible-galaxy install -r requirements.yml", false, C.ansible),
            text("vault encrypt", "🔒", "ansible-vault encrypt ", false, C.vault),
            text("vault view", "👁", "ansible-vault view ", false, C.vault),
            text("doc module", "📘", "ansible-doc ", false, C.ansible)
        ]},
        veille: { label: "Veille sécu", sym: "📚", icon: "radar", color: C.web, keys: [
            shortcuts.owasp,
            shortcuts.nvd,
            shortcuts.mitre,
            web("CERT-FR", "FR", "https://www.cert.ssi.gouv.fr/"),
            web("CISA KEV", "KEV", "https://www.cisa.gov/known-exploited-vulnerabilities-catalog")
        ]},
        docker: { label: "Docker", sym: "🐳", icon: "docker", color: C.docker, terminal: true, keys: [
            text("ps", "ps", "docker ps", true, C.docker),
            text("ps -a", "ps-a", "docker ps -a", true, C.docker),
            text("images", "🖼", "docker images", true, C.docker),
            // dive : couches d'une image ({} = image sélectionnée dans le terminal)
            withPick(textIcon("dive", "dive", "dive {}", false, C.docker, "lucide-layers-2"), "dive {image}"),
            withPick(text("logs -f", "📜", "docker logs -f ", false, C.docker), "docker logs -f {container}"),
            withPick(text("exec -it", ">_", "docker exec -it {} sh", false, C.docker), "docker exec -it {container} sh"),
            text("build", "🔨", "docker build -t ", false, C.docker),
            text("run --rm", "▶", "docker run --rm -it ", false, C.docker),
            withPick(text("inspect", "🔍", "docker inspect ", false, C.docker), "docker inspect {container}"),
            text("compose up", "⬆", "docker compose up -d", true, C.docker),
            text("compose logs", "📜", "docker compose logs -f", true, C.docker),
            text("compose down", "⬇", "docker compose down", false, C.docker),
            text("stats", "📊", "docker stats --no-stream", true, C.docker),
            text("prune", "🧹", "docker system prune", false, C.danger)
        ]},
        helm: { label: "Helm", sym: "⎈", icon: "helm", color: C.helm, terminal: true, keys: [
            text("list -A", "⎈", "helm list -A", true, C.helm),
            text("repo update", "⟳", "helm repo update", true, C.helm),
            text("search repo", "🔍", "helm search repo ", false, C.helm),
            // en production : « helm diff » d'abord (extension helm-diff), puis la vraie commande au 2e clic
            prodGuard(withDiff(text("upgrade -i", "⬆", "helm upgrade --install ", false, C.helm), "helm diff upgrade --install ")),
            text("status", "ℹ", "helm status ", false, C.helm),
            text("history", "🕘", "helm history ", false, C.helm),
            text("get values", "📄", "helm get values ", false, C.helm),
            text("show values", "📋", "helm show values ", false, C.helm),
            text("lint", "✔", "helm lint .", true, C.helm),
            text("template", "🧩", "helm template .", true, C.helm),
            prodGuard(text("rollback", "↩", "helm rollback ", false, C.danger)),
            prodGuard(text("uninstall", "🗑", "helm uninstall ", false, C.danger)),
            web("Artifact Hub", "🔎", "https://artifacthub.io")
        ]},
        // $HOME fonctionne dans PowerShell, Git Bash et zsh ; cmd utilise %USERPROFILE%
        ssh: { label: "SSH", sym: "ssh", icon: "ssh-key", color: C.ssh, terminal: true, keys: [
            text("mes clés", "🗝", sh("ls $HOME/.ssh", "ls $HOME/.ssh", "dir %USERPROFILE%\\.ssh"), true, C.ssh),
            text("keygen ed25519", "➕", 'ssh-keygen -t ed25519 -a 100 -C "', false, C.ssh),
            text("copier clé pub", "📋", {
                windows: sh(
                    "clip < $HOME/.ssh/id_ed25519.pub",
                    "Get-Content $HOME/.ssh/id_ed25519.pub | Set-Clipboard",
                    "clip < %USERPROFILE%\\.ssh\\id_ed25519.pub"
                ),
                mac: "pbcopy < $HOME/.ssh/id_ed25519.pub",
                linux: "xclip -selection clipboard < $HOME/.ssh/id_ed25519.pub"
            }, true, C.ssh),
            text("fingerprint", "#", sh("ssh-keygen -lf $HOME/.ssh/id_ed25519.pub", "ssh-keygen -lf $HOME/.ssh/id_ed25519.pub", "ssh-keygen -lf %USERPROFILE%\\.ssh\\id_ed25519.pub"), true, C.ssh),
            text("agent: clés", "ag", "ssh-add -l", true, C.ssh),
            // macOS : agent launchd + trousseau. Windows : Git Bash démarre son propre agent si besoin ;
            // PowerShell / cmd utilisent le service « OpenSSH Authentication Agent » de Windows.
            text("agent: ajouter", "ag+", {
                windows: sh(
                    '[ -n "$SSH_AUTH_SOCK" ] || eval "$(ssh-agent -s)"; ssh-add $HOME/.ssh/id_ed25519',
                    "ssh-add $HOME/.ssh/id_ed25519",
                    "ssh-add %USERPROFILE%\\.ssh\\id_ed25519"
                ),
                mac: "ssh-add --apple-use-keychain $HOME/.ssh/id_ed25519",
                linux: "ssh-add $HOME/.ssh/id_ed25519"
            }, true, C.ssh),
            // connexion : texte sélectionné (ou à compléter) ; sans sélection, liste des hôtes de ~/.ssh/config
            withPick(textIcon("connexion", "→", "ssh ", false, C.ssh, "lucide-log-in"), "ssh {host}"),
            // connexion avec une clé précise : clés privées de ~/.ssh (noms seulement), puis hôte
            withPick(textIcon("connexion -i", "-i", "ssh -i ", false, C.ssh, "lucide-key-square"), "ssh -i {identity} {host}"),
            text("test GitHub", "🐙", "ssh -T git@github.com", true, C.ssh),
            text("ssh verbose", "-v", "ssh -v ", false, C.ssh),
            withPick(text("tunnel -L", "⇄", "ssh -N -L 8080:localhost:80 ", false, C.ssh), "ssh -N -L {local=8080}:{cible=localhost}:{distant=80} {host}"),
            text("keyscan", "📡", "ssh-keyscan -t ed25519 ", false, C.ssh),
            text("oublier hôte", "✖", "ssh-keygen -R ", false, C.danger),
            text("éditer config", "⚙", sshConfig, true, C.tool),
            text("ssh-audit", "🔎", "ssh-audit ", false, C.sec)
        ]},
        // Linux / Unix : commandes d'administration d'un serveur (souvent après un ssh) ; tapées telles quelles,
        // quel que soit le shell local. Lecture seule = exécutée (vert) ; le reste est à compléter (orange).
        // Patchs des VMs : voyant (inventaire au clic) et commandes de vérification sur la VM (après un ssh)
        patchs: { label: "Patchs", sym: "🩹", icon: "lucide-calendar-check", color: C.patch, terminal: true, keys: [
            status("patches", "patchs", "🩹", C.patch),
            withPick(textIcon("ssh VM", "ssh", "ssh ", false, C.patch, "lucide-log-in"), "ssh {host}"),
            withPick(textIcon("ssh -i VM", "-i", "ssh -i ", false, C.patch, "lucide-key-square"), "ssh -i {identity} {host}"),
            { ...textIcon("MAJ (apt)", "apt", "sudo apt-get update -qq && apt list --upgradable 2>/dev/null | tail -n +2", true, C.patch, "lucide-package-search"), unix: true },
            { ...textIcon("MAJ (dnf)", "dnf", "sudo dnf -q check-update", true, C.patch, "lucide-package-search"), unix: true },
            { ...textIcon("sécurité seule", "sec", "sudo dnf -q updateinfo list --security 2>/dev/null || apt list --upgradable 2>/dev/null | grep -i security", true, C.sec, "lucide-shield-check"), unix: true },
            { ...textIcon("reboot requis ?", "↻", "[ -f /var/run/reboot-required ] && cat /var/run/reboot-required* || needs-restarting -r 2>/dev/null || echo 'aucun redémarrage signalé'", true, C.patch, "lucide-refresh-ccw"), unix: true },
            { ...textIcon("noyau et boot", "ℹ", "uname -r; uptime; who -b 2>/dev/null", true, C.patch, "lucide-server-cog"), unix: true },
            { ...textIcon("historique", "🕘", "(grep -h ' upgrade ' /var/log/dpkg.log* 2>/dev/null | tail -20) || sudo dnf history list | head -15", true, C.patch, "lucide-history"), unix: true },
            textIcon("correctifs Windows", "KB", sh(null, "Get-HotFix | Sort-Object InstalledOn -Descending | Select-Object -First 10 HotFixID, Description, InstalledOn", null), true, C.patch, "lucide-shield-check"),
            { ...textIcon("redémarrer", "⏻", "sudo shutdown -r +1 'redemarrage apres patch'", false, C.danger, "lucide-power"), unix: true }
        ]},
        linux: { label: "Linux / Unix", sym: "🐧", icon: "linux", color: C.linux, terminal: true, keys: [
            textIcon("système", "ℹ", "uname -a; cat /etc/os-release 2>/dev/null | head -4; uptime", true, C.linux, "lucide-info"),
            textIcon("top", "📊", "htop 2>/dev/null || top", true, C.linux, "lucide-activity"),
            textIcon("processus", "🔍", "pgrep -af {}", false, C.linux, "lucide-list-tree"),
            textIcon("kill", "✖", "kill {}", false, C.danger, "lucide-octagon-x"),
            textIcon("mémoire", "▦", "free -h", true, C.linux, "lucide-memory-stick"),
            textIcon("disque", "▦", "df -h", true, C.linux, "lucide-hard-drive"),
            textIcon("gros dossiers", "📁", "du -sh -- * .[!.]* 2>/dev/null | sort -h | tail -15", true, C.linux, "lucide-folder-search"),
            textIcon("ports", "🔌", "ss -tulpn", true, C.linux, "lucide-plug"),
            textIcon("services", "⚙", "systemctl list-units --type=service --state=running --no-pager", true, C.linux, "lucide-server-cog"),
            textIcon("statut svc", "🩺", "systemctl status {} --no-pager", false, C.linux, "lucide-stethoscope"),
            textIcon("restart svc", "⟳", "sudo systemctl restart {}", false, C.danger, "lucide-refresh-cw"),
            textIcon("logs svc", "📜", "journalctl -u {} -f", false, C.linux, "lucide-scroll-text"),
            textIcon("erreurs", "⚠", "journalctl -p err -b -n 50 --no-pager", true, C.linux, "lucide-triangle-alert"),
            textIcon("tail -f", "📄", "tail -f {}", false, C.linux, "lucide-file-text"),
            textIcon("find", "🔎", 'find . -iname "*{}*" 2>/dev/null', false, C.linux, "lucide-file-search"),
            textIcon("grep", "🔍", 'grep -rIn --color=auto "{}" .', false, C.linux, "lucide-text-search")
        ]},
        openssl: { label: "OpenSSL", sym: "🔏", icon: "certificate", color: C.openssl, terminal: true, keys: [
            // Voyant : certificats de la mission active (Réglages › Missions › Certificats)
            status("certs", "certificats", "🔒", C.openssl),
            text("version", "ver", "openssl version -a", true, C.openssl),
            text("clé RSA 4096", "RSA", "openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out key.pem", false, C.openssl),
            text("clé EC P-256", "EC", "openssl ecparam -genkey -name prime256v1 -noout -out ec.key", false, C.openssl),
            text("CSR", "CSR", "openssl req -new -key key.pem -out req.csr", false, C.openssl),
            text("lire CSR", "📄", "openssl req -in req.csr -noout -text", false, C.openssl),
            // Git Bash convertit "/CN=..." en chemin Windows : MSYS_NO_PATHCONV=1 l'en empêche
            text("auto-signé", "📜", {
                windows: sh(`MSYS_NO_PATHCONV=1 ${selfSigned}`, selfSigned, selfSigned),
                mac: selfSigned,
                linux: selfSigned
            }, false, C.openssl),
            text("lire cert", "🔍", "openssl x509 -in cert.pem -noout -text", false, C.openssl),
            text("dates cert", "📅", "openssl x509 -in cert.pem -noout -subject -issuer -dates", false, C.openssl),
            text("TLS distant", "🌐", "openssl s_client -showcerts -connect ", false, C.openssl),
            text("vérifier chaîne", "⛓", "openssl verify -CAfile ca.pem cert.pem", false, C.openssl),
            text("PKCS#12", "p12", "openssl pkcs12 -export -out bundle.p12 -inkey key.pem -in cert.pem", false, C.openssl),
            text("SHA-256", "#", "openssl dgst -sha256 ", false, C.openssl),
            text("secret aléa", "🎲", "openssl rand -base64 32", true, C.tool)
        ]}
    };

    // Retire les touches non disponibles sur ce système
    for (const s of Object.values(sections)) s.keys = s.keys.filter(Boolean);

    // Efface le terminal (Ctrl+L pour PowerShell, bash et zsh ; "cls" pour cmd) : tout à droite de la ligne
    const clear = { type: "clear", label: "clear", sym: "🧹", icon: "lucide-brush-cleaning", color: C.tool, pin: "0,2" };

    return { shortcuts, sections, clear };
}

// ---------- Mise en page ----------

// 5 x 4 cases en ordre de lecture (l'accueil peut avoir jusqu'à 18 touches sur la ligne)
const POSITIONS = [0, 1, 2, 3].flatMap((r) => [0, 1, 2, 3, 4].map((c) => `${c},${r}`));
const ROOT_MAX = 18;
const SECTION_MAX = 17;   // touches d'une rubrique, clear compris (Retour en plus)

/** Place les touches à position fixe (pin) puis remplit les cases libres dans l'ordre. */
function layout(keys, page = {}) {
    for (const k of keys.filter((k) => k.pin)) page[k.pin] = k;
    const free = POSITIONS.filter((p) => !(p in page));
    keys.filter((k) => !k.pin).forEach((k, i) => { page[free[i]] = k; });
    return page;
}

// ---------- Touches personnelles (config.jsonc : customSections, customShortcuts) ----------

const ID = /^[a-z0-9][a-z0-9-]{0,30}$/;

/**
 * Touche définie dans la configuration :
 *   { label, command | url, enter?, icon?, color? }
 * command : chaîne, { windows, mac, linux } et/ou { posix, powershell, cmd } ; {} = emplacement de la sélection.
 * enter : true = exécutée (pastille verte), sinon seulement tapée (orange). url : ouvre un onglet (http/https).
 */
function customKey(def, where) {
    if (!def || typeof def !== "object") throw new Error(`${where} : touche invalide`);
    const label = String(def.label ?? "").trim().slice(0, 30);
    if (!label) throw new Error(`${where} : "label" manquant`);
    const color = /^#[0-9a-f]{6}$/i.test(def.color ?? "") ? def.color : C.tool;
    const sym = typeof def.sym === "string" && def.sym ? def.sym.slice(0, 4) : label.slice(0, 3);
    let key;
    if (def.url != null) {
        if (!/^https?:\/\//i.test(String(def.url))) throw new Error(`${where} : "url" doit commencer par http:// ou https://`);
        key = web(label, sym, String(def.url), color);
    } else if (def.command != null) {
        key = text(label, sym, def.command, def.enter === true, color);
    } else {
        throw new Error(`${where} : il faut "command" ou "url"`);
    }
    if (!key) return null;   // pas de variante pour ce système
    if (typeof def.description === "string" && def.description.trim()) key = { ...key, desc: def.description.trim().slice(0, 120) };
    if (def.icon != null) {
        if (iconFile(def.icon)) key = { ...key, icon: def.icon };
        else console.warn(`  ${where} : icône introuvable "${def.icon}" (ex. "lucide-rocket", "github")`);
    }
    return key;
}

function customCatalog(cfg) {
    const sections = {};
    for (const [id, def] of Object.entries(cfg.customSections ?? {})) {
        if (!ID.test(id)) throw new Error(`customSections : identifiant invalide "${id}" (minuscules, chiffres, tirets)`);
        if (!def || !Array.isArray(def.keys)) throw new Error(`customSections.${id} : "keys" doit être une liste`);
        const color = /^#[0-9a-f]{6}$/i.test(def.color ?? "") ? def.color : C.tool;
        const icon = def.icon != null && iconFile(def.icon) ? def.icon : undefined;
        sections[id] = {
            label: String(def.label ?? id).slice(0, 30),
            sym: typeof def.sym === "string" && def.sym ? def.sym.slice(0, 4) : "★",
            icon,
            color,
            terminal: true,
            keys: def.keys.map((k, i) => customKey(k, `customSections.${id}.keys[${i}]`)).filter(Boolean)
        };
    }
    const shortcuts = {};
    for (const [id, def] of Object.entries(cfg.customShortcuts ?? {})) {
        if (!ID.test(id)) throw new Error(`customShortcuts : identifiant invalide "${id}"`);
        shortcuts[id] = customKey(def, `customShortcuts.${id}`);
    }
    return { sections, shortcuts };
}

// ---------- Favoris : rubrique "favoris", et une page par groupe / sous-groupe ----------

const favPage = (groupId) => `fav-${groupId}`;

/**
 * Touches d'un niveau des favoris : sites et groupes, puis Modifier et Ajouter à droite.
 * color : couleur héritée du groupe (les sites prennent la couleur de leur groupe ; un sous-groupe peut avoir la sienne).
 */
function favoriteKeys(items, groupId, depth, color = C.fav) {
    const keys = items.map((f) => f.type === "group"
        ? { ...folder(f.label, "▣", favPage(f.id), f.color ?? color, f.icon), fav: f.id, favGroup: true, favIcon: f.chosen ?? "", favColor: f.color ?? "", favCount: f.items.length }
        : { ...web(f.label, "★", f.url, color), icon: f.icon, fav: f.id, favIcon: f.chosen ?? "" });
    keys.push(
        { type: "fav-edit", label: "Modifier", sym: "✎", icon: "lucide-pencil", color: C.tool, right: true },
        { type: "fav-add", label: "Ajouter", sym: "+", icon: "lucide-plus", color, right: true, favParent: groupId, favDepth: depth }
    );
    return keys;
}

/** Pages des groupes (en plus de la rubrique) : { nom, titre, parent, touches }. */
function favoriteGroupPages(items, parentPage, depth, color = C.fav) {
    return items.filter((f) => f.type === "group").flatMap((g) => [
        { name: favPage(g.id), title: g.label, parent: parentPage, keys: favoriteKeys(g.items, g.id, depth + 1, g.color ?? color) },
        ...favoriteGroupPages(g.items, favPage(g.id), depth + 1, g.color ?? color)
    ]);
}

function favoritesSection(favorites) {
    return { label: "Favoris", sym: "★", icon: "lucide-bookmark", color: C.fav, keys: favoriteKeys(favorites, null, 0) };
}

/**
 * Pages du deck : { root: [touches ou null], <rubrique>: [...] }, et l'index des touches par id
 * (le serveur ne lance que des commandes "run" de ce catalogue, jamais une commande venue du navigateur).
 */
/**
 * @param worlds rubriques activées / désactivées dans les Réglages, en écart avec cfg.sections ({ id: bool })
 * @param worldOrder ordre des rubriques choisi dans les Réglages ([] = celui de config.jsonc)
 * @param userSections rubriques créées dans Réglages › Mes actions (server/actions.mjs)
 */
export function buildDeck(ctx, favorites = [], worlds = {}, worldOrder = [], userSections = []) {
    const { cfg } = ctx;
    const { shortcuts: SHORTCUTS, sections: SECTIONS, clear } = buildCatalog(ctx);
    SECTIONS.favoris = favoritesSection(favorites);
    // Mes actions : une rubrique par entrée, touches commande (exécutée / à compléter) ou lien ;
    // les actions épinglées vont aussi sur l'accueil (comptées dans les 18 touches)
    const pinnedKeys = [];
    for (const s of userSections) {
        SECTIONS[s.id] = {
            label: s.label, sym: s.label.slice(0, 3), icon: iconFile(s.icon) ? s.icon : "lucide-star", color: s.color, terminal: true,
            keys: s.actions.map((a) => {
                const sym = a.label.slice(0, 3);
                const key = a.kind === "url" ? web(a.label, sym, a.url, s.color) : text(a.label, sym, a.command, a.enter, s.color);
                if (!key) return null;
                // Sans icône choisie : globe pour un lien, terminal pour une commande
                const icon = a.icon && iconFile(a.icon) ? a.icon : a.kind === "url" ? "lucide-globe" : "lucide-square-terminal";
                const full = { ...key, icon, ...(a.description ? { desc: a.description } : {}), userAction: a.id };
                if (a.pinned) pinnedKeys.push(full);
                return full;
            })
        };
    }
    const custom = customCatalog(cfg);
    for (const [id, def] of Object.entries(custom.sections)) {
        if (SECTIONS[id]) throw new Error(`customSections : "${id}" existe déjà, choisis un autre identifiant`);
        SECTIONS[id] = def;
    }
    for (const [id, key] of Object.entries(custom.shortcuts)) {
        if (id in SHORTCUTS) throw new Error(`customShortcuts : "${id}" existe déjà, choisis un autre identifiant`);
        SHORTCUTS[id] = key;
    }

    const unknownSections = (cfg.sections ?? []).filter((s) => !SECTIONS[s]);
    if (unknownSections.length) throw new Error(`rubrique(s) inconnue(s) : ${unknownSections.join(", ")}. Disponibles : ${Object.keys(SECTIONS).join(", ")}`);
    const unknownShortcuts = (cfg.shortcuts ?? []).filter((s) => !(s in SHORTCUTS));
    if (unknownShortcuts.length) throw new Error(`raccourci(s) inconnu(s) : ${unknownShortcuts.join(", ")}. Disponibles : ${Object.keys(SHORTCUTS).join(", ")}`);

    const exclude = new Set(cfg.excludeTools ?? []);
    const allowed = (key) => key && !(key.tool && exclude.has(key.tool));
    const skipped = (cfg.shortcuts ?? []).filter((s) => !SHORTCUTS[s]);
    const shortcuts = (cfg.shortcuts ?? []).filter((s) => allowed(SHORTCUTS[s]));
    // Rubriques : celles de config.jsonc (dans leur ordre), puis les autres du catalogue (désactivées par défaut) ;
    // les Réglages peuvent activer ou désactiver chacune. Une rubrique sans aucune touche sur ce système
    // (ex. Ansible sous Windows) n'est pas proposée (Favoris a toujours Ajouter).
    const configured = cfg.sections ?? [];
    const defaultOrder = [...configured, ...Object.keys(SECTIONS).filter((s) => !configured.includes(s))];
    // Ordre des Réglages d'abord (identifiants connus), puis les autres dans l'ordre par défaut
    const chosen = (worldOrder ?? []).filter((s) => SECTIONS[s]);
    const order = [...chosen, ...defaultOrder.filter((s) => !chosen.includes(s))];
    const usable = order.filter((s) => {
        const empty = !SECTIONS[s].keys.some(allowed);
        if (empty && configured.includes(s)) skipped.push(s);
        return !empty;
    });
    const enabled = (s) => (typeof worlds?.[s] === "boolean" ? worlds[s] : configured.includes(s));
    const sections = usable.filter(enabled);
    const worldList = usable.map((s) => {
        const icon = pick(SECTIONS[s].icon);
        if (icon && iconFile(icon)) ICONS.add(icon);
        return { id: s, label: pick(SECTIONS[s].label), icon: icon ?? null, color: SECTIONS[s].color, on: enabled(s), byDefault: configured.includes(s) };
    });
    // clear sur l'accueil aussi (bord droit), comme dans les rubriques qui tapent dans le terminal
    const rootClear = cfg.clearKey ? 1 : 0;
    const total = sections.length + shortcuts.length + pinnedKeys.length + rootClear;
    if (total > ROOT_MAX) throw new Error(`${total} touches demandées sur la page d'accueil (max ${ROOT_MAX}). Retire des rubriques ou des raccourcis.`);

    const layouts = {};
    const rootKeys = [];
    const titles = { root: "Accueil" };
    const parents = {};   // page -> page parente (fil d'Ariane et Retour)
    for (const s of sections) {
        const def = { ...SECTIONS[s], label: pick(SECTIONS[s].label), sym: pick(SECTIONS[s].sym) };
        rootKeys.push(folder(def.label, def.sym, s, def.color, pick(def.icon)));
        titles[s] = def.label;
        const keys = def.keys.filter(allowed).map((k) => (def.unix ? { ...k, unix: true } : k));
        if (cfg.clearKey && def.terminal) keys.push(clear);
        if (keys.length > SECTION_MAX) throw new Error(`la rubrique "${s}" a ${keys.length} touches (max ${SECTION_MAX}).`);
        layouts[s] = layout(keys, { "0,0": back() });
        parents[s] = "root";
        // Favoris : une page par groupe et sous-groupe
        if (s === "favoris") {
            for (const p of favoriteGroupPages(favorites, "favoris", 0)) {
                layouts[p.name] = layout(p.keys, { "0,0": back(p.parent) });
                titles[p.name] = p.title;
                parents[p.name] = p.parent;
            }
        }
    }
    for (const s of shortcuts) rootKeys.push(SHORTCUTS[s]);
    rootKeys.push(...pinnedKeys);
    if (rootClear) rootKeys.push(clear);
    layouts.root = layout(rootKeys);

    // Identifiants stables "page/colonne,ligne" ; la commande des touches "run" n'est pas envoyée au navigateur
    const index = new Map();
    const pages = {};
    for (const [name, page] of Object.entries(layouts)) {
        pages[name] = POSITIONS.map((pos) => {
            const key = page[pos];
            if (!key) return null;
            const id = `${name}/${pos}`;
            index.set(id, key);
            if (key.icon && iconFile(key.icon)) ICONS.add(key.icon);
            const { command, tool, needs, ...rest } = key;
            // needs : outil installable requis (la page grise la touche s'il manque, voir server/tools.mjs)
            const visible = neededTool(key) ? { ...rest, needs: neededTool(key) } : rest;
            // Infobulle : ce que fait l'action (server/descriptions.mjs, ou "description" d'une touche de config.jsonc)
            const desc = key.desc ?? DESCRIPTIONS[`${name}/${key.label}`];
            if (desc) visible.desc = desc;   // pin reste visible : la page aligne à droite les touches épinglées
            return { id, ...visible };
        });
    }
    return { pages, titles, parents, index, skipped, worlds: { list: worldList, shortcuts: shortcuts.length + pinnedKeys.length + rootClear, max: ROOT_MAX, defaultOrder: defaultOrder.filter((s) => worldList.some((w) => w.id === s)) } };
}
