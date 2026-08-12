import { describe, expect, it } from "vitest";
import { isEncryptedKey, stripEncrypted } from "./encrypted";

describe("isEncryptedKey", () => {
  it("matches AM's `<field>-encrypted` companion convention", () => {
    expect(isEncryptedKey("password-encrypted")).toBe(true);
    expect(isEncryptedKey("clientSecret-encrypted")).toBe(true);
  });

  it("does NOT match a key that merely contains the substring", () => {
    // Deliberate divergence from frodo's `indexOf(...) > -1`, which would eat these.
    expect(isEncryptedKey("is-encrypted-enabled")).toBe(false);
    expect(isEncryptedKey("-encrypted-thing")).toBe(false);
  });

  it("does not match ordinary fields", () => {
    expect(isEncryptedKey("password")).toBe(false);
    expect(isEncryptedKey("encrypted")).toBe(false);
    expect(isEncryptedKey("hostName")).toBe(false);
  });
});

describe("stripEncrypted", () => {
  it("drops `<field>-encrypted` and keeps everything else byte-identical", () => {
    const out = stripEncrypted({
      hostName: "localhost",
      hostPort: 1025,
      password: null,
      "password-encrypted": "AQICAHjcm9mCT1V0kQ==",
      sslOption: "NON_SSL",
    });
    expect(out).toEqual({
      hostName: "localhost",
      hostPort: 1025,
      password: null,
      sslOption: "NON_SSL",
    });
    expect(out).not.toHaveProperty("password-encrypted");
  });

  it("keeps the nulled plaintext companion — it is a real, writable field", () => {
    // Dropping `password` too would silently discard the user's intent to clear it.
    expect(stripEncrypted({ password: null, "password-encrypted": "x" })).toHaveProperty(
      "password",
      null,
    );
  });

  it("strips at any depth, including inside arrays", () => {
    const out = stripEncrypted({
      nodes: [
        { _id: "a", "password-encrypted": "x" },
        { _id: "b", inner: { "clientSecret-encrypted": "y", clientId: "c" } },
      ],
    });
    expect(out).toEqual({
      nodes: [{ _id: "a" }, { _id: "b", inner: { clientId: "c" } }],
    });
  });

  it("never mutates its input (compare holds both sides at once)", () => {
    const input = { a: 1, "password-encrypted": "secret" };
    const out = stripEncrypted(input);
    expect(input).toHaveProperty("password-encrypted", "secret");
    expect(out).not.toBe(input);
  });

  it("passes through primitives, null and empty objects untouched", () => {
    expect(stripEncrypted(null)).toBeNull();
    expect(stripEncrypted("str")).toBe("str");
    expect(stripEncrypted(7)).toBe(7);
    expect(stripEncrypted({})).toEqual({});
    expect(stripEncrypted([])).toEqual([]);
  });

  it("leaves an object with no encrypted keys structurally equal", () => {
    const input = { a: { b: [1, 2, { c: "d" }] }, e: null };
    expect(stripEncrypted(input)).toEqual(input);
  });
});
