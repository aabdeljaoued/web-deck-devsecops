import assert from "node:assert/strict";
import { test } from "node:test";

import { liveParam, paramOptions } from "../server/params.mjs";

test("paramètres à liste réelle : noms et alias reconnus, les autres non", () => {
    assert.equal(liveParam("namespace"), "namespace");
    assert.equal(liveParam("NS"), "namespace");
    assert.equal(liveParam("svc"), "service");
    assert.equal(liveParam("deploy"), "deployment");
    assert.equal(liveParam("conteneur"), "container");
    assert.equal(liveParam("durée"), null);
});

test("paramètre sans liste réelle : aucune valeur, aucune commande lancée", async () => {
    assert.deepEqual(await paramOptions({ apps: {} }, "durée"), []);
});

test("namespace transmis à kubectl : vérifié (pas d'option injectée)", async () => {
    await assert.rejects(paramOptions({ apps: { kubectl: "/bin/echo" } }, "pod", { namespace: "-n x" }), /namespace invalide/);
});
