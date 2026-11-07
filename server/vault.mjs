// Coffre chiffré : notes et secrets (tokens, mots de passe) de la mission.
// Fichier vault.enc (exclu de Git) chiffré en AES-256-GCM ; clé dérivée du mot de passe maître avec scrypt.
// La clé et le contenu déchiffré ne vivent qu'en mémoire, et sont effacés au verrouillage
// (manuel, après inactivité, ou à l'arrêt du serveur). Les valeurs des secrets ne quittent le serveur
// que sur demande explicite (copier / afficher) ; "taper dans le terminal" les écrit côté serveur.
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scrypt as scryptCb } from "node:crypto";
import { EventEmitter } from "node:events";
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);
const KDF = { N: 1 << 16, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };   // ~64 Mo, ~0,1-0,3 s par dérivation
const MIN_PASSWORD = 8;
export const IDLE_LOCK_MS = 15 * 60 * 1000;

const clip = (v, max) => String(v ?? "").replace(/\u0000/g, "").slice(0, max);

/** Événement "change" : état ou contenu modifié (à renvoyer aux pages). */
export class Vault extends EventEmitter {
    /** @param backups sauvegardes automatiques (server/backups.mjs), facultatif */
    constructor(file, backups = null) {
        super();
        this.file = file;
        this.backups = backups;
        this.key = null;
        this.salt = null;
        this.data = null;
        this.lastUse = 0;
        this.failures = 0;
        this.timer = setInterval(() => {
            if (this.key && Date.now() - this.lastUse > IDLE_LOCK_MS) this.lock("inactivité");
        }, 30 * 1000);
        this.timer.unref();
    }

    get exists() { return existsSync(this.file); }
    get unlocked() { return Boolean(this.key); }

    touch() { this.lastUse = Date.now(); }

    /** État et contenu visibles par la page : notes complètes, secrets sans leur valeur. */
    view() {
        if (!this.unlocked) return { exists: this.exists, unlocked: false };
        return {
            exists: true,
            unlocked: true,
            idleLockMin: IDLE_LOCK_MS / 60000,
            notes: this.data.notes,
            secrets: this.data.secrets.map(({ value, ...meta }) => ({ ...meta, length: value.length }))
        };
    }

    async derive(password, salt) {
        return scrypt(String(password), salt, 32, KDF);
    }

    /** Création du coffre (refusée s'il existe déjà). */
    async create(password) {
        if (this.exists) throw new Error("le coffre existe déjà");
        if (String(password ?? "").length < MIN_PASSWORD) throw new Error(`mot de passe maître trop court (${MIN_PASSWORD} caractères minimum)`);
        this.salt = randomBytes(16);
        this.key = await this.derive(password, this.salt);
        this.data = { notes: [], secrets: [] };
        this.save();
        this.touch();
        this.emit("change");
    }

    /** Déverrouillage ; chaque échec retarde la tentative suivante (jusqu'à 5 s). */
    async unlock(password) {
        if (!this.exists) throw new Error("aucun coffre : crée-le d'abord");
        if (this.failures) await new Promise((r) => setTimeout(r, Math.min(5000, 1000 * this.failures)));
        const box = JSON.parse(readFileSync(this.file, "utf8"));
        const salt = Buffer.from(box.salt, "base64");
        const key = await this.derive(password, salt);
        try {
            const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64"));
            decipher.setAuthTag(Buffer.from(box.tag, "base64"));
            const plain = Buffer.concat([decipher.update(Buffer.from(box.data, "base64")), decipher.final()]);
            this.data = JSON.parse(plain.toString("utf8"));
        } catch {
            this.failures++;
            throw new Error("mot de passe incorrect");
        }
        this.failures = 0;
        this.salt = salt;
        this.key = key;
        this.touch();
        this.emit("change");
    }

    lock(reason = "") {
        if (!this.key) return;
        this.key.fill(0);
        this.key = null;
        this.data = null;
        this.emit("change", reason);
    }

    /** Changement du mot de passe maître (nouveau sel, nouvelle clé). */
    async changePassword(current, next) {
        this.need();
        const check = await this.derive(current, this.salt);
        if (!check.equals(this.key)) throw new Error("mot de passe actuel incorrect");
        if (String(next ?? "").length < MIN_PASSWORD) throw new Error(`nouveau mot de passe trop court (${MIN_PASSWORD} caractères minimum)`);
        this.salt = randomBytes(16);
        this.key = await this.derive(next, this.salt);
        this.save();
    }

    need() {
        if (!this.unlocked) throw new Error("coffre verrouillé");
        this.touch();
    }

    // ---------- Export / import (autre machine) ----------

    /** Export : le fichier chiffré tel quel (jamais déchiffré), seulement coffre déverrouillé. */
    exportBox() {
        this.need();
        return { app: "web-deck-devsecops", kind: "coffre", version: 1, exported: new Date().toISOString(), vault: JSON.parse(readFileSync(this.file, "utf8")) };
    }

    /** Boîte chiffrée d'un export (ou d'un vault.enc copié tel quel), vérifiée champ par champ. */
    static parseBox(data) {
        const box = data?.kind === "coffre" ? data.vault : data;
        const b64 = (v) => typeof v === "string" && v.length > 0 && v.length < 4 * 1024 * 1024 && /^[A-Za-z0-9+/]+=*$/.test(v);
        if (!box || box.v !== 1 || box.kdf !== "scrypt" || ![box.salt, box.iv, box.tag, box.data].every(b64)) {
            throw new Error("fichier non reconnu : ce n'est pas un export du coffre du deck");
        }
        if (box.N !== KDF.N || box.r !== KDF.r || box.p !== KDF.p) throw new Error("paramètres de chiffrement inattendus dans le fichier");
        return { v: 1, kdf: "scrypt", N: box.N, r: box.r, p: box.p, salt: box.salt, iv: box.iv, tag: box.tag, data: box.data };
    }

    /** Déchiffre une boîte avec son mot de passe ; un échec ralentit la tentative suivante, comme le déverrouillage. */
    async openBox(box, password) {
        if (this.failures) await new Promise((r) => setTimeout(r, Math.min(5000, 1000 * this.failures)));
        const salt = Buffer.from(box.salt, "base64");
        const key = await this.derive(password, salt);
        let data;
        try {
            const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64"));
            decipher.setAuthTag(Buffer.from(box.tag, "base64"));
            data = JSON.parse(Buffer.concat([decipher.update(Buffer.from(box.data, "base64")), decipher.final()]).toString("utf8"));
        } catch {
            this.failures++;
            throw new Error("mot de passe du fichier incorrect");
        }
        this.failures = 0;
        if (!Array.isArray(data?.notes) || !Array.isArray(data?.secrets)) throw new Error("contenu du coffre importé invalide");
        return { key, salt, data };
    }

    /**
     * Import : "use" (aucun coffre ici : le fichier devient le coffre), "merge" (ajoute ce qui manque,
     * garde la version la plus récente d'un même élément) ou "replace" (copie de l'ancien dans vault.enc.bak).
     * Le mot de passe est celui du fichier importé ; le coffre reste déverrouillé après l'import.
     */
    async importBox(data, mode, password) {
        const box = Vault.parseBox(data);
        if (mode === "use") {
            if (this.exists) throw new Error("un coffre existe déjà ici : déverrouille-le, puis Fusionner ou Remplacer");
        } else if (mode === "merge" || mode === "replace") {
            this.need();
        } else {
            throw new Error(`mode d'import inconnu : ${mode}`);
        }
        const opened = await this.openBox(box, password);
        const stats = { notes: opened.data.notes.length, secrets: opened.data.secrets.length, added: 0, updated: 0 };
        this.backups?.before(this.file, { force: true });
        if (mode === "merge") {
            for (const kind of ["notes", "secrets"]) {
                for (const item of opened.data[kind]) {
                    if (typeof item?.id !== "string") continue;
                    const mine = this.data[kind].find((x) => x.id === item.id);
                    if (!mine) { this.data[kind].push(item); stats.added++; }
                    else if (String(item.updated ?? "") > String(mine.updated ?? "")) { Object.assign(mine, item); stats.updated++; }
                }
            }
            this.save();
        } else {
            if (mode === "replace") copyFileSync(this.file, `${this.file}.bak`);
            const tmp = `${this.file}.tmp`;
            writeFileSync(tmp, JSON.stringify(box), { mode: 0o600 });
            renameSync(tmp, this.file);
            if (this.key) this.key.fill(0);
            Object.assign(this, { key: opened.key, salt: opened.salt, data: opened.data });
        }
        this.touch();
        this.emit("change");
        return stats;
    }

    /** Écriture atomique : fichier temporaire puis renommage (pas de coffre à moitié écrit). */
    save() {
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", this.key, iv);
        const data = Buffer.concat([cipher.update(JSON.stringify(this.data), "utf8"), cipher.final()]);
        const box = {
            v: 1, kdf: "scrypt", N: KDF.N, r: KDF.r, p: KDF.p,
            salt: this.salt.toString("base64"), iv: iv.toString("base64"),
            tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64")
        };
        const tmp = `${this.file}.tmp`;
        writeFileSync(tmp, JSON.stringify(box), { mode: 0o600 });
        this.backups?.before(this.file);
        renameSync(tmp, this.file);
    }

    // ---------- Notes ----------

    /** color : "#rrggbb", "" (aucune) ; absente = inchangée. */
    saveNote({ id, title, body, color }) {
        this.need();
        const note = { title: clip(title, 120).trim() || "Sans titre", body: clip(body, 200000), updated: new Date().toISOString() };
        if (color !== undefined) {
            const c = String(color ?? "").trim().toLowerCase();
            if (c && !/^#[0-9a-f]{6}$/.test(c)) throw new Error(`couleur invalide : ${c} (format #rrggbb)`);
            note.color = c || null;
        }
        const existing = id && this.data.notes.find((n) => n.id === id);
        if (existing) Object.assign(existing, note);
        else this.data.notes.unshift({ id: randomUUID(), ...note });
        this.save();
        this.emit("change");
        return existing?.id ?? this.data.notes[0].id;
    }

    deleteNote(id) {
        this.need();
        this.data.notes = this.data.notes.filter((n) => n.id !== id);
        this.save();
        this.emit("change");
    }

    // ---------- Secrets ----------

    /** Création ou modification ; value absente = valeur inchangée (modification sans la ressaisir). */
    saveSecret({ id, name, user, url, note, value }) {
        this.need();
        const meta = { name: clip(name, 80).trim(), user: clip(user, 200).trim(), url: clip(url, 500).trim(), note: clip(note, 2000), updated: new Date().toISOString() };
        if (!meta.name) throw new Error("le nom est obligatoire");
        const existing = id && this.data.secrets.find((s) => s.id === id);
        if (existing) {
            Object.assign(existing, meta);
            if (value != null && value !== "") existing.value = clip(value, 10000);
        } else {
            if (value == null || value === "") throw new Error("la valeur du secret est obligatoire");
            this.data.secrets.unshift({ id: randomUUID(), ...meta, value: clip(value, 10000) });
        }
        this.save();
        this.emit("change");
    }

    deleteSecret(id) {
        this.need();
        this.data.secrets = this.data.secrets.filter((s) => s.id !== id);
        this.save();
        this.emit("change");
    }

    /** Valeur d'un secret, seulement sur demande explicite (copier, afficher, taper). */
    secretValue(id) {
        this.need();
        const secret = this.data.secrets.find((s) => s.id === id);
        if (!secret) throw new Error("secret introuvable");
        return secret.value;
    }
}
