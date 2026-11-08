import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { Backups } from "../server/backups.mjs";
import { tmpDir } from "./helpers.mjs";

test("au plus une copie toutes les 10 min, sauf copie forcée ; 10 gardées", () => {
    const dir = tmpDir();
    const file = path.join(dir, "favoris.json");
    const b = new Backups(path.join(dir, ".deck-backups"));
    writeFileSync(file, "[1]");
    b.before(file);
    b.before(file);
    assert.equal(b.list("favoris.json").length, 1);
    for (let i = 0; i < 15; i++) b.before(file, { force: true });
    assert.equal(b.list("favoris.json").length, 10);
    if (process.platform !== "win32") assert.equal(statSync(path.join(b.dir, b.list("favoris.json")[0].id)).mode & 0o777, 0o600);
});

test("restauration : remet la copie et sauvegarde la version actuelle", () => {
    const dir = tmpDir();
    const file = path.join(dir, "settings.json");
    const b = new Backups(path.join(dir, ".deck-backups"));
    writeFileSync(file, "v1");
    b.before(file, { force: true });
    const v1 = b.list("settings.json")[0].id;
    writeFileSync(file, "v2");
    b.restore(file, v1);
    assert.equal(readFileSync(file, "utf8"), "v1");
    assert.equal(b.list("settings.json").length, 2, "la version v2 a été sauvegardée avant");
    assert.throws(() => b.restore(file, "../../etc/passwd"), /introuvable/);
});

test("fichiers inconnus ignorés", () => {
    const dir = tmpDir();
    const b = new Backups(path.join(dir, ".deck-backups"));
    writeFileSync(path.join(dir, "autre.txt"), "x");
    assert.equal(b.before(path.join(dir, "autre.txt"), { force: true }), null);
});
