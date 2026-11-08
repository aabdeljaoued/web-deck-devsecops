import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { Journal } from "../server/journal.mjs";
import { tmpDir } from "./helpers.mjs";

test("journal : ajout, relecture, plus récente d'abord, export CSV, effacement", () => {
    const file = path.join(tmpDir(), ".deck-journal.jsonl");
    const j = new Journal(file);
    j.add({ label: "pods", page: "K8s", command: "kubectl get pods", mode: "run", kube: "prod-eu / default", prod: true });
    j.add({ label: "logs -f", page: "K8s", command: "kubectl logs -f web\n", mode: "type" });
    const again = new Journal(file);
    assert.deepEqual(again.recent().map((e) => `${e.label}:${e.mode}`), ["logs -f:tapée", "pods:exécutée"]);
    assert.ok(!again.recent()[0].command.includes("\n"), "retours à la ligne neutralisés");
    const csv = again.csv();
    assert.match(csv, /^date;action;rubrique;commande/);
    assert.match(csv, /"oui"/);
    again.clear();
    assert.equal(readFileSync(file, "utf8"), "");
});
