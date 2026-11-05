import assert from "node:assert/strict";
import { createDecipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listSecrets, normalizeRemark, removeSecret, renameSecret, saveSecret, setSecretRemark } from "./secret-vault.ts";

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

function open(dir, key, name) {
  const r = JSON.parse(readFileSync(join(dir, "vault.json"), "utf8")).records[name];
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(r.iv, "base64"));
  d.setAAD(Buffer.from(`pi-secret-vault:v1:${name}`, "utf8"));
  d.setAuthTag(Buffer.from(r.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(r.ct, "base64")), d.final()]).toString("utf8");
}

test("a remark is listed, survives replacing the value, and can be cleared without the key", () => {
  const f = fixture();
  try {
    saveSecret("a", "value-aaaaaa", f.dir, f.keys, "for ci");
    assert.equal(listSecrets(f.dir)[0].remark, "for ci");
    saveSecret("a", "value-bbbbbb", f.dir, f.keys);
    assert.equal(listSecrets(f.dir)[0].remark, "for ci");
    assert.equal(setSecretRemark("a", "changed", f.dir), true);
    assert.equal(listSecrets(f.dir)[0].remark, "changed");
    assert.equal(setSecretRemark("a", undefined, f.dir), true);
    assert.equal("remark" in listSecrets(f.dir)[0], false);
    assert.equal(setSecretRemark("missing", "x", f.dir), false);
    assert.equal(open(f.dir, f.key(), "a"), "value-bbbbbb");
  } finally {
    f.done();
  }
});

test("renaming re-encrypts under the new name and keeps its metadata", () => {
  const f = fixture();
  try {
    saveSecret("a", "value-aaaaaa", f.dir, f.keys, "for ci");
    saveSecret("taken", "value-tttttt", f.dir, f.keys);
    const before = listSecrets(f.dir).find((e) => e.name === "a");
    assert.equal(renameSecret("a", "taken", f.dir, f.keys), "taken");
    assert.equal(renameSecret("nope", "b", f.dir, f.keys), "missing");
    assert.throws(() => renameSecret("a", "Bad Name", f.dir, f.keys), /Invalid/);
    assert.equal(renameSecret("a", "b", f.dir, f.keys), "renamed");
    assert.equal(open(f.dir, f.key(), "b"), "value-aaaaaa");
    assert.deepEqual(listSecrets(f.dir).find((e) => e.name === "b"), { ...before, name: "b" });
    assert.equal(listSecrets(f.dir).some((e) => e.name === "a"), false);
  } finally {
    f.done();
  }
});

test("remarks are one line and refuse what looks like a credential", () => {
  assert.equal(normalizeRemark(" a\n  b "), "a b");
  assert.equal(normalizeRemark("  "), undefined);
  for (const ok of [
    "公司 Jenkins 部署 · https://jenkins.example.com · 用户名 deploy",
    "token for the GitHub CLI, user deploy",
    "host prod-eu-west-1-rabbitmq-cluster-03.internal.example.com",
  ]) assert.equal(normalizeRemark(ok), ok);
  for (const bad of [
    "use {{sec:gh}}",
    "https://deploy:hunter2@ci.example.com",
    "https://ci.example.com/?token=abc",
    `github ${"ghp_"}aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0iL3oR6`,
    "key aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0iL3oR6",
    "x".repeat(201),
  ]) assert.throws(() => normalizeRemark(bad), /Remark/);
});
