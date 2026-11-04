import assert from "node:assert/strict";
import { createDecipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listSecrets, removeSecret, saveSecret } from "./secret-vault.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-vault-"));
  let key;
  const keys = { read: () => key, create: () => (key = randomBytes(32)) };
  return { dir, keys, key: () => key, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("stores ciphertext the extension's format can open, bound to the name", () => {
  const f = fixture();
  try {
    saveSecret("gh_token", "plain-value-123", f.dir, f.keys);
    const raw = readFileSync(join(f.dir, "vault.json"), "utf8");
    assert.doesNotMatch(raw, /plain-value-123/);
    const file = JSON.parse(raw);
    assert.equal(file.version, 1);
    const r = file.records.gh_token;
    const d = createDecipheriv("aes-256-gcm", f.key(), Buffer.from(r.iv, "base64"));
    d.setAAD(Buffer.from("pi-secret-vault:v1:gh_token", "utf8"));
    d.setAuthTag(Buffer.from(r.tag, "base64"));
    assert.equal(Buffer.concat([d.update(Buffer.from(r.ct, "base64")), d.final()]).toString("utf8"), "plain-value-123");
  } finally {
    f.done();
  }
});

test("listing exposes metadata only", () => {
  const f = fixture();
  try {
    saveSecret("b", "value-bbbbbb", f.dir, f.keys);
    saveSecret("a", "value-aaaaaa", f.dir, f.keys);
    const list = listSecrets(f.dir);
    assert.deepEqual(list.map((e) => e.name), ["a", "b"]);
    assert.deepEqual(Object.keys(list[0]).sort(), ["addedAt", "length", "name", "source"]);
    assert.equal(removeSecret("a", f.dir), true);
    assert.equal(removeSecret("a", f.dir), false);
  } finally {
    f.done();
  }
});

test("refuses bad input and never mints a key over existing records", () => {
  const f = fixture();
  try {
    assert.throws(() => saveSecret("Bad Name", "value-123456", f.dir, f.keys), /Invalid/);
    assert.throws(() => saveSecret("ok", "   ", f.dir, f.keys), /empty/);
    saveSecret("ok", "value-123456", f.dir, f.keys);
    const lost = { read: () => undefined, create: () => assert.fail("must not create a key") };
    assert.throws(() => saveSecret("next", "value-123456", f.dir, lost), /key is gone/);
  } finally {
    f.done();
  }
});
