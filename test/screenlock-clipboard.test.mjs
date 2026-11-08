import assert from "node:assert/strict";
import { test } from "node:test";

import { macLocked, ScreenLock, windowsLocked } from "../server/screenlock.mjs";

test("macOS : session verrouillée lue dans ioreg", () => {
    const base = '"IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"kCGSessionLoginDoneKey"=Yes';
    assert.equal(macLocked(`${base}})`), false);
    assert.equal(macLocked(`${base},"CGSSessionScreenIsLocked"=Yes})`), true);
    assert.equal(macLocked(`${base},"CGSSessionScreenIsLocked"=No})`), false);
});

test("Windows : écran de verrouillage = processus LogonUI", () => {
    assert.equal(windowsLocked([{ name: "explorer" }, { name: "logonui" }]), true);
    assert.equal(windowsLocked([{ name: "explorer" }]), false);
});

test("événement change seulement au changement d'état", () => {
    const s = new ScreenLock(null);
    const seen = [];
    s.on("change", (locked) => seen.push(locked));
    for (const v of [false, true, true, false]) s.set(v);
    assert.deepEqual(seen, [true, false]);
});
