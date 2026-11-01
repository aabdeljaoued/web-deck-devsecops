// Catalogue des touches : raccourcis de la page d'accueil et rubriques (dossiers), puis mise en page.
//
// Une commande peut être une chaîne (identique partout) ou { windows: ..., mac: ... } (variante par système).
// Une touche dont la variante n'existe pas pour le système courant est ignorée.
// Pour les touches qui tapent dans le terminal, une variante peut encore dépendre du shell :
// sh(posix, powershell, cmd) ; la page choisit selon le shell de l'onglet actif.
import { platform } from "./platform.mjs";

export const COLORS = {
    git: "#F05032", k8s: "#326CE5", sec: "#C62828", terraform: "#7B42BC", vault: "#FFC107",
    ssh: "#2E7D32", openssl: "#AD1457", docker: "#0898C8", helm: "#5C6BC0", vscode: "#007ACC",
    tool: "#37474F", web: "#00897B", danger: "#B71C1C", brew: "#FBB040", ansible: "#5BBDBF"
};
const C = COLORS;

const isPlatformMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && ("windows" in v || "mac" in v || "linux" in v);
const pick = (v) => (isPlatformMap(v) ? v[platform] : v);

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
    return { type: "text", label, sym, color, tool: first.split(" ")[0], badge: enter ? "run" : "type", text: cmd, enter };
}

function web(label, sym, url, color = C.web) {
    return { type: "web", label, sym, color, url };
}

/** Lance un programme sur la machine (la commande reste côté serveur). */
function run(label, sym, command, color = C.tool, tool) {
    const cmd = pick(command);
    if (!cmd || cmd.some((part) => !part)) return null;
    return { type: "run", label, sym, color, tool, command: cmd };
}

/**
 * icon : nom d'un logo affiché à la place de sym, servi par /icons/<nom>.svg :
 * public/icons/<nom>.svg (icônes du projet) sinon simple-icons.
 */
function folder(label, sym, page, color, icon) {
    return { type: "folder", label, sym, color, page, ...(icon ? { icon } : {}) };
}

/** Logos utilisés par le catalogue : le serveur ne sert que ceux-là. */
export const ICONS = new Set();

function back() {
    return { type: "back", label: "Retour", sym: "↩", color: "#212121" };
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
        return key && { ...key, pin: "4,2" };
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
            text("pull rebase", "⬇", "git pull --rebase", true, C.git),
            text("log graph", "log", "git log --oneline --graph --decorate -20", true, C.git),
            text("diff stat", "±", "git diff --stat", true, C.git),
            text("fetch prune", "⟳", "git fetch --all --prune", true, C.git),
            text("commit signé", "✍", 'git commit -S -m "', false, C.git),
            text("push", "⬆", "git push", false, C.git),
            text("branches", "br", "git branch -vv", true, C.git),
            text("stash", "📥", "git stash", true, C.git),
            text("stash pop", "📤", "git stash pop", true, C.git),
            text("nouvelle branche", "➕", "git switch -c ", false, C.git),
            text("restore", "↺", "git restore ", false, C.danger),
            text("amend", "✎", "git commit --amend", false, C.danger)
        ]},
        k8s: { label: "K8s / OCP", sym: "☸", icon: "kubernetes", color: C.k8s, terminal: true, keys: [
            text("contexts", "ctx", "kubectl config get-contexts", true, C.k8s),
            text("pods -A", "pod", "kubectl get pods -A", true, C.k8s),
            text("events", "⚡", "kubectl get events -A --sort-by=.lastTimestamp", true, C.k8s),
            text("nodes", "▦", "kubectl get nodes -o wide", true, C.k8s),
            text("svc / ingress", "svc", "kubectl get svc,ingress -A", true, C.k8s),
            text("logs -f", "📜", "kubectl logs -f ", false, C.k8s),
            text("describe", "🔍", "kubectl describe pod ", false, C.k8s),
            text("RBAC can-i", "🛂", "kubectl auth can-i --list", true, C.sec),
            text("NetPol", "🧱", "kubectl get networkpolicies -A", true, C.sec),
            text("oc whoami", "oc", sh("oc whoami; oc project", "oc whoami; oc project", "oc whoami & oc project"), true, C.k8s),
            text("crc status", "crc", "crc status", true, C.k8s),
            shortcuts["crc-console"],
            text("top pods", "📊", "kubectl top pods -A", true, C.k8s)
        ]},
        sec: { label: "Sécurité", sym: "🛡", color: C.sec, terminal: true, keys: [
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
        brew: { label: { windows: "Scoop", mac: "Brew", linux: "Brew" }, sym: { windows: "🍨", mac: "🍺", linux: "🍺" }, icon: { mac: "homebrew", linux: "homebrew" }, color: C.brew, terminal: true, keys: [
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
        // Ansible ne tourne pas nativement sous Windows (WSL seulement) : rubrique masquée sous Windows
        ansible: { label: "Ansible", sym: "A", icon: "ansible", color: C.ansible, terminal: true, keys: [
            text("version", "ver", { mac: "ansible --version", linux: "ansible --version" }, true, C.ansible),
            text("ping all", "📡", { mac: "ansible all -m ping", linux: "ansible all -m ping" }, true, C.ansible),
            text("inventaire", "🗂", { mac: "ansible-inventory --graph", linux: "ansible-inventory --graph" }, true, C.ansible),
            text("playbook", "▶", { mac: "ansible-playbook ", linux: "ansible-playbook " }, false, C.ansible),
            text("check --diff", "🔍", { mac: "ansible-playbook --check --diff ", linux: "ansible-playbook --check --diff " }, false, C.ansible),
            text("syntax check", "✔", { mac: "ansible-playbook --syntax-check ", linux: "ansible-playbook --syntax-check " }, false, C.ansible),
            text("list tasks", "📋", { mac: "ansible-playbook --list-tasks ", linux: "ansible-playbook --list-tasks " }, false, C.ansible),
            text("ad-hoc shell", ">_", { mac: "ansible all -m shell -a \"", linux: "ansible all -m shell -a \"" }, false, C.ansible),
            text("ansible-lint", "🔎", { mac: "ansible-lint", linux: "ansible-lint" }, true, C.sec),
            text("galaxy install", "⬇", { mac: "ansible-galaxy install -r requirements.yml", linux: "ansible-galaxy install -r requirements.yml" }, false, C.ansible),
            text("vault encrypt", "🔒", { mac: "ansible-vault encrypt ", linux: "ansible-vault encrypt " }, false, C.vault),
            text("vault view", "👁", { mac: "ansible-vault view ", linux: "ansible-vault view " }, false, C.vault),
            text("doc module", "📘", { mac: "ansible-doc ", linux: "ansible-doc " }, false, C.ansible)
        ]},
        veille: { label: "Veille sécu", sym: "📚", color: C.web, keys: [
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
            text("logs -f", "📜", "docker logs -f ", false, C.docker),
            text("exec -it", ">_", "docker exec -it ", false, C.docker),
            text("build", "🔨", "docker build -t ", false, C.docker),
            text("run --rm", "▶", "docker run --rm -it ", false, C.docker),
            text("inspect", "🔍", "docker inspect ", false, C.docker),
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
            text("upgrade -i", "⬆", "helm upgrade --install ", false, C.helm),
            text("status", "ℹ", "helm status ", false, C.helm),
            text("history", "🕘", "helm history ", false, C.helm),
            text("get values", "📄", "helm get values ", false, C.helm),
            text("show values", "📋", "helm show values ", false, C.helm),
            text("lint", "✔", "helm lint .", true, C.helm),
            text("template", "🧩", "helm template .", true, C.helm),
            text("rollback", "↩", "helm rollback ", false, C.danger),
            text("uninstall", "🗑", "helm uninstall ", false, C.danger),
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
            text("test GitHub", "🐙", "ssh -T git@github.com", true, C.ssh),
            text("ssh verbose", "-v", "ssh -v ", false, C.ssh),
            text("tunnel -L", "⇄", "ssh -N -L 8080:localhost:80 ", false, C.ssh),
            text("keyscan", "📡", "ssh-keyscan -t ed25519 ", false, C.ssh),
            text("oublier hôte", "✖", "ssh-keygen -R ", false, C.danger),
            text("éditer config", "⚙", sshConfig, true, C.tool),
            text("ssh-audit", "🔎", "ssh-audit ", false, C.sec)
        ]},
        openssl: { label: "OpenSSL", sym: "🔏", color: C.openssl, terminal: true, keys: [
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
    const clear = { type: "clear", label: "clear", sym: "🧹", color: C.tool, pin: "0,2" };

    return { shortcuts, sections, clear };
}

// ---------- Mise en page ----------

const POSITIONS = [0, 1, 2].flatMap((r) => [0, 1, 2, 3, 4].map((c) => `${c},${r}`));   // ordre de lecture

/** Place les touches à position fixe (pin) puis remplit les cases libres dans l'ordre. */
function layout(keys, page = {}) {
    for (const k of keys.filter((k) => k.pin)) page[k.pin] = k;
    const free = POSITIONS.filter((p) => !(p in page));
    keys.filter((k) => !k.pin).forEach((k, i) => { page[free[i]] = k; });
    return page;
}

/**
 * Pages du deck : { root: [15 touches ou null], <rubrique>: [...] }, et l'index des touches par id
 * (le serveur ne lance que des commandes "run" de ce catalogue, jamais une commande venue du navigateur).
 */
export function buildDeck(ctx) {
    const { cfg } = ctx;
    const { shortcuts: SHORTCUTS, sections: SECTIONS, clear } = buildCatalog(ctx);

    const unknownSections = (cfg.sections ?? []).filter((s) => !SECTIONS[s]);
    if (unknownSections.length) throw new Error(`rubrique(s) inconnue(s) : ${unknownSections.join(", ")}. Disponibles : ${Object.keys(SECTIONS).join(", ")}`);
    const unknownShortcuts = (cfg.shortcuts ?? []).filter((s) => !(s in SHORTCUTS));
    if (unknownShortcuts.length) throw new Error(`raccourci(s) inconnu(s) : ${unknownShortcuts.join(", ")}. Disponibles : ${Object.keys(SHORTCUTS).join(", ")}`);

    const exclude = new Set(cfg.excludeTools ?? []);
    const allowed = (key) => key && !(key.tool && exclude.has(key.tool));
    const skipped = (cfg.shortcuts ?? []).filter((s) => !SHORTCUTS[s]);
    const shortcuts = (cfg.shortcuts ?? []).filter((s) => allowed(SHORTCUTS[s]));
    // Rubrique sans aucune touche sur ce système (ex. Ansible sous Windows) : pas de dossier vide
    const sections = (cfg.sections ?? []).filter((s) => {
        const empty = !SECTIONS[s].keys.some(allowed);
        if (empty) skipped.push(s);
        return !empty;
    });
    const total = sections.length + shortcuts.length;
    if (total > 15) throw new Error(`${total} touches demandées sur la page d'accueil (max 15). Retire des rubriques ou des raccourcis.`);

    const layouts = {};
    const rootKeys = [];
    const titles = { root: "Accueil" };
    for (const s of sections) {
        const def = { ...SECTIONS[s], label: pick(SECTIONS[s].label), sym: pick(SECTIONS[s].sym) };
        const icon = pick(def.icon);
        if (icon) ICONS.add(icon);
        rootKeys.push(folder(def.label, def.sym, s, def.color, icon));
        titles[s] = def.label;
        const keys = def.keys.filter(allowed);
        if (cfg.clearKey && def.terminal) keys.push(clear);
        if (keys.length > 14) throw new Error(`la rubrique "${s}" a ${keys.length} touches (max 14).`);
        layouts[s] = layout(keys, { "0,0": back() });
    }
    for (const s of shortcuts) rootKeys.push(SHORTCUTS[s]);
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
            const { command, tool, ...visible } = key;   // pin reste visible : la page aligne à droite les touches épinglées
            return { id, ...visible };
        });
    }
    return { pages, titles, index, skipped };
}
