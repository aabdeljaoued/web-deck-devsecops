// Patchs des VMs (rubrique Patchs) : inventaire des machines avec dernier et prochain patch, description,
// environnement, hôte SSH et fréquence. Enregistré dans patches.json (hors Git, sauvegardé comme les favoris).
// Le voyant « patchs » et ses alertes sont calculés par server/status.mjs à partir de ces dates.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const MAX_VMS = 200;
export const ENVIRONMENTS = ["production", "recette", "qualification", "développement", "autre"];

/** Environnement saisi librement -> valeur de ENVIRONMENTS (prod, rec, qualif, dev… acceptés) ; null si inconnu. */
export function normalizeEnv(v) {
    const s = String(v ?? "").trim().toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
    const aliases = { prod: "production", production: "production", prd: "production", rec: "recette", recette: "recette", recet: "recette", uat: "recette",
        qualif: "qualification", qualification: "qualification", qa: "qualification", preprod: "qualification", dev: "développement", developpement: "développement",
        development: "développement", autre: "autre", other: "autre" };
    return aliases[s] ?? null;
}

const text = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Date « AAAA-MM-JJ » valide (ou vide) ; erreur claire sinon. */
function cleanDay(v, what) {
    const s = text(v, 10);
    if (!s) return "";
    const d = new Date(`${s}T00:00:00Z`);
    if (!ISO_DAY.test(s) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new Error(`${what} : date invalide (${s})`);
    return s;
}

/** Jour local au format AAAA-MM-JJ. */
export function today(now = new Date()) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Ajoute n jours à une date AAAA-MM-JJ. */
export function addDays(day, n) {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

/** Jours entre aujourd'hui et une date AAAA-MM-JJ (négatif = dépassée). */
export function daysUntil(day, now = new Date()) {
    return Math.round((new Date(`${day}T00:00:00Z`) - new Date(`${today(now)}T00:00:00Z`)) / 86400000);
}

/** Tags libres : « linux, dmz » ou liste ; minuscules, lettres / chiffres / . _ -, 10 au plus, sans doublon. */
export function cleanTags(v) {
    const list = Array.isArray(v) ? v : String(v ?? "").split(/[,|;\s]+/);
    const tags = [...new Set(list.map((t) => String(t).trim().toLowerCase().replace(/^#/, "")).filter(Boolean))];
    for (const t of tags) if (!/^[\p{L}\p{N}_.-]{1,24}$/u.test(t)) throw new Error(`tag invalide : « ${t} » (lettres, chiffres, . _ -, 24 caractères au plus)`);
    if (tags.length > 10) throw new Error("10 tags au plus par VM");
    return tags;
}

export function cleanVm(def) {
    const name = text(def?.name, 60);
    if (!name) throw new Error("le nom de la VM est obligatoire");
    const host = text(def?.host, 120);
    if (host && !/^[A-Za-z0-9_.@:-]+$/.test(host)) throw new Error(`hôte SSH invalide : ${host} (ex. app-prod-01 ou admin@10.0.0.5)`);
    // Clé privée pour « ssh -i » : chemin tapé dans le terminal, donc sans caractère de shell (; | & $ ` " ' …)
    const identity = text(def?.identity, 300).replace(/^"(.*)"$/, "$1");
    if (identity && !/^[A-Za-z0-9_.:~\\/ -]+$/.test(identity)) throw new Error(`clé SSH : chemin invalide (${identity})`);
    const env = text(def?.env, 20) || "autre";
    if (!ENVIRONMENTS.includes(env)) throw new Error(`environnement inconnu : ${env}`);
    const every = def?.everyDays === "" || def?.everyDays == null ? null : Number(def.everyDays);
    if (every !== null && (!Number.isInteger(every) || every < 1 || every > 730)) throw new Error("fréquence : nombre de jours entre 1 et 730");
    const lastPatch = cleanDay(def?.lastPatch, "dernier patch");
    const nextPatch = cleanDay(def?.nextPatch, "prochain patch");
    return {
        name,
        host,
        identity,
        env,
        description: text(def?.description, 500),
        tags: cleanTags(def?.tags),
        lastPatch,
        // Prochain patch déduit du dernier et de la fréquence s'il n'est pas donné
        nextPatch: nextPatch || (lastPatch && every ? addDays(lastPatch, every) : ""),
        everyDays: every
    };
}

export class Patches {
    constructor(file, backups = null) {
        this.file = file;
        this.backups = backups;
        this.reload();
    }

    reload() {
        this.vms = [];
        if (!existsSync(this.file)) return;
        try {
            const data = JSON.parse(readFileSync(this.file, "utf8"));
            for (const vm of Array.isArray(data?.vms) ? data.vms : []) {
                try { this.vms.push({ id: /^vm-[0-9a-f]{8}$/.test(vm.id) ? vm.id : newId(), ...cleanVm(vm) }); }
                catch (err) { console.warn(`  patches.json : VM ignorée (${err.message})`); }
            }
        } catch (err) {
            console.warn(`  patches.json illisible : ${err.message}`);
        }
    }

    /** VMs triées du prochain patch le plus proche au plus lointain. */
    list() {
        return [...this.vms].sort((a, b) => a.nextPatch.localeCompare(b.nextPatch) || a.name.localeCompare(b.name));
    }

    /** Création (sans id) ou modification ; nom unique (sans tenir compte de la casse). */
    save(def) {
        const vm = cleanVm(def);
        if (!vm.nextPatch) throw new Error("indique la date du prochain patch (ou le dernier patch et la fréquence)");
        const id = def?.id ? String(def.id) : null;
        if (this.vms.some((v) => v.id !== id && v.name.toLowerCase() === vm.name.toLowerCase())) throw new Error(`une VM s'appelle déjà « ${vm.name} »`);
        if (id) {
            const i = this.vms.findIndex((v) => v.id === id);
            if (i < 0) throw new Error("VM introuvable");
            this.vms[i] = { id, ...vm };
        } else {
            if (this.vms.length >= MAX_VMS) throw new Error(`${MAX_VMS} VMs au plus`);
            this.vms.push({ id: newId(), ...vm });
        }
        this.write();
        return id ?? this.vms.at(-1).id;
    }

    /** « Patché » : dernier patch = ce jour ; prochain = ce jour + fréquence (sinon inchangé s'il est encore à venir). */
    markPatched(id, day = today()) {
        const vm = this.vms.find((v) => v.id === id);
        if (!vm) throw new Error("VM introuvable");
        vm.lastPatch = cleanDay(day, "date du patch");
        if (vm.everyDays) vm.nextPatch = addDays(vm.lastPatch, vm.everyDays);
        else if (vm.nextPatch <= vm.lastPatch) vm.nextPatch = "";
        this.write();
        return vm;
    }

    remove(id) {
        const before = this.vms.length;
        this.vms = this.vms.filter((v) => v.id !== id);
        if (this.vms.length === before) throw new Error("VM introuvable");
        this.write();
    }

    /**
     * Import en masse : VMs ajoutées, ou mises à jour si le nom existe déjà (sans tenir compte de la casse) ;
     * aucune suppression. dryRun : seulement le décompte (aperçu avant confirmation).
     */
    importMany(vms, { dryRun = false } = {}) {
        const seen = new Set();
        let added = 0, updated = 0;
        const errors = [];
        const next = this.vms.map((v) => ({ ...v }));
        for (const { line, vm } of vms) {
            const key = vm.name.toLowerCase();
            if (seen.has(key)) { errors.push(`ligne ${line} : « ${vm.name} » apparaît deux fois dans le fichier`); continue; }
            seen.add(key);
            const i = next.findIndex((v) => v.name.toLowerCase() === key);
            if (i >= 0) { next[i] = { id: next[i].id, ...vm }; updated++; }
            else { next.push({ id: newId(), ...vm }); added++; }
        }
        if (next.length > MAX_VMS) throw new Error(`l'inventaire dépasserait ${MAX_VMS} VMs`);
        if (!dryRun && (added || updated)) {
            this.backups?.before(this.file, { force: true });
            this.vms = next;
            this.write(false);
        }
        return { added, updated, errors };
    }

    /** Remplacement complet (import de la configuration) : chaque VM revalidée. */
    replace(vms) {
        if (!Array.isArray(vms) || vms.length > MAX_VMS) throw new Error("liste de VMs invalide");
        const next = vms.map((vm) => ({ id: /^vm-[0-9a-f]{8}$/.test(vm?.id) ? vm.id : newId(), ...cleanVm(vm) }));
        this.backups?.before(this.file, { force: true });
        this.vms = next;
        this.write(false);
    }

    write(backup = true) {
        if (backup) this.backups?.before(this.file);
        writeFileSync(this.file, `${JSON.stringify({ vms: this.vms }, null, 2)}\n`);
    }
}

const newId = () => `vm-${randomBytes(4).toString("hex")}`;

// ---------- Import / export en masse (CSV, compatible Excel) ----------

/** Colonnes reconnues (sans casse, accents, espaces ni tirets) -> champ d'une VM. */
const COLUMNS = {
    nom: "name", name: "name", vm: "name", machine: "name", serveur: "name",
    hote: "host", host: "host", hotessh: "host", sshhost: "host", adresse: "host",
    cle: "identity", clessh: "identity", identity: "identity", key: "identity", sshkey: "identity",
    environnement: "env", env: "env", environment: "env",
    dernierpatch: "lastPatch", lastpatch: "lastPatch", dernier: "lastPatch", last: "lastPatch",
    prochainpatch: "nextPatch", nextpatch: "nextPatch", prochain: "nextPatch", next: "nextPatch",
    frequence: "everyDays", frequencejours: "everyDays", every: "everyDays", everydays: "everyDays", interval: "everyDays",
    description: "description", desc: "description", commentaire: "description", notes: "description",
    tags: "tags", tag: "tags", etiquettes: "tags", labels: "tags"
};
const EXPORT_HEADER = ["nom", "hote", "cle", "environnement", "dernier_patch", "prochain_patch", "frequence", "tags", "description"];
const colKey = (h) => String(h).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z]/g, "");

/** Découpe un CSV (guillemets, séparateur doublé dans les guillemets, retours à la ligne entre guillemets). */
export function parseCsv(text) {
    const src = String(text ?? "").replace(/^\uFEFF/, "");
    const firstLine = src.split(/\r?\n/)[0] ?? "";
    const counts = [";", ",", "\t"].map((d) => [d, firstLine.split(d).length]);
    const sep = counts.sort((a, b) => b[1] - a[1])[0][0];
    const rows = [];
    let row = [], cell = "", quoted = false, line = 1, rowLine = 1;
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (quoted) {
            if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
            else if (ch === '"') quoted = false;
            else { if (ch === "\n") line++; cell += ch; }
        } else if (ch === '"' && cell === "") quoted = true;
        else if (ch === sep) { row.push(cell); cell = ""; }
        else if (ch === "\n" || ch === "\r") {
            if (ch === "\r" && src[i + 1] === "\n") i++;
            row.push(cell); rows.push({ line: rowLine, cells: row }); row = []; cell = ""; line++; rowLine = line;
        } else cell += ch;
    }
    if (cell !== "" || row.length) { row.push(cell); rows.push({ line: rowLine, cells: row }); }
    return { sep, rows: rows.filter((r) => r.cells.some((c) => c.trim() !== "")) };
}

/** JJ/MM/AAAA (ou AAAA-MM-JJ) -> AAAA-MM-JJ ; autre chose rendu tel quel (refusé ensuite par cleanVm). */
function isoDay(v) {
    const s = String(v ?? "").trim();
    const fr = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
    return fr ? `${fr[3]}-${fr[2].padStart(2, "0")}-${fr[1].padStart(2, "0")}` : s;
}

/**
 * Lignes CSV -> VMs : en-tête obligatoire (colonne « nom » au moins), une VM par ligne. Renvoie les VMs valides
 * (avec leur numéro de ligne) et les erreurs « ligne n : raison ».
 */
export function vmsFromCsv(text) {
    const { rows } = parseCsv(text);
    if (!rows.length) throw new Error("fichier vide");
    const [head, ...data] = rows;
    const fields = head.cells.map((h) => COLUMNS[colKey(h)] ?? null);
    if (!fields.includes("name")) throw new Error(`colonne « nom » introuvable dans l'en-tête (colonnes reconnues : ${EXPORT_HEADER.join(", ")})`);
    if (data.length > MAX_VMS) throw new Error(`${data.length} lignes : ${MAX_VMS} VMs au plus`);
    const vms = [];
    const errors = [];
    for (const r of data) {
        const def = {};
        fields.forEach((f, i) => { if (f) def[f] = r.cells[i] ?? ""; });
        if (def.lastPatch != null) def.lastPatch = isoDay(def.lastPatch);
        if (def.nextPatch != null) def.nextPatch = isoDay(def.nextPatch);
        if (def.env != null) def.env = String(def.env).trim() ? normalizeEnv(def.env) ?? String(def.env).trim().toLowerCase() : "autre";
        try {
            const vm = cleanVm(def);
            if (!vm.nextPatch) throw new Error("prochain patch manquant (ou dernier patch et fréquence)");
            vms.push({ line: r.line, vm });
        } catch (err) {
            errors.push(`ligne ${r.line} : ${err.message}`);
        }
    }
    return { vms, errors };
}

/** Inventaire en CSV (séparateur « ; », dates JJ/MM/AAAA, BOM pour Excel). */
export function vmsToCsv(vms) {
    const q = (v) => (/[;,"\n\r]/.test(String(v ?? "")) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ""));
    const fr = (d) => (d ? d.split("-").reverse().join("/") : "");
    const lines = vms.map((v) => [v.name, v.host, v.identity, v.env, fr(v.lastPatch), fr(v.nextPatch), v.everyDays ?? "", (v.tags ?? []).join(", "), v.description].map(q).join(";"));
    return `\uFEFF${[EXPORT_HEADER.join(";"), ...lines].join("\r\n")}\r\n`;
}
