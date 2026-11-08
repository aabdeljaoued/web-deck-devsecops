// Outils communs aux tests : dossier temporaire supprimé à la fin (rien n'est écrit dans le projet).
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";

export function tmpDir() {
    const dir = mkdtempSync(path.join(os.tmpdir(), "deck-test-"));
    after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}
