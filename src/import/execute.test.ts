import { describe, expect, it, vi } from "vitest";
import { PaicError } from "../paic/errors";
import { type ExecuteClient, runExecute, type WritePlanItem } from "./execute";
import type { ImportComponent } from "./parse";

function client(over: Record<string, unknown> = {}): ExecuteClient {
  return {
    writeTheme: vi.fn(() => Promise.resolve("created" as const)),
    writeEmailTemplate: vi.fn(() => Promise.resolve("overwritten" as const)),
    writeSocialIdp: vi.fn(() => Promise.resolve("created" as const)),
    writeEsvVariable: vi.fn(() => Promise.resolve("created" as const)),
    writeEsvSecret: vi.fn(() => Promise.resolve("created" as const)),
    writeScript: vi.fn(() => Promise.resolve("created" as const)),
    ...over,
  } as unknown as ExecuteClient;
}

const comp = (over: Partial<ImportComponent>): ImportComponent => ({
  kind: "theme",
  id: "t",
  displayName: "T",
  raw: { _id: "t" },
  ...over,
});

const item = (component: ImportComponent, over: Partial<WritePlanItem> = {}): WritePlanItem => ({
  component,
  verdict: "new",
  ...over,
});

describe("runExecute", () => {
  it("returns the client's created/overwritten outcome per component", async () => {
    const r = await runExecute(client(), "alpha", [
      item(comp({ kind: "theme" })),
      item(comp({ kind: "emailTemplate", id: "emailTemplate/w", raw: { _id: "emailTemplate/w" } })),
    ]);
    expect(r[0].status).toBe("created");
    expect(r[1].status).toBe("overwritten");
  });

  it("invokes onResult once per item, in write order (PD-16)", async () => {
    const order: string[] = [];
    await runExecute(
      client(),
      "alpha",
      [
        item(comp({ kind: "theme", id: "t1", raw: { _id: "t1" } })),
        item(comp({ kind: "theme", id: "t2", raw: { _id: "t2" } })),
      ],
      (r) => order.push(`${r.kind}:${r.id}:${r.status}`),
    );
    expect(order).toEqual(["theme:t1:created", "theme:t2:created"]);
  });

  it("G2: a leaf socialIdp write strips invalid attrs + retries once (S10b)", async () => {
    const writeSocialIdp = vi
      .fn()
      .mockRejectedValueOnce(
        new PaicError("Invalid attribute specified.", {
          status: 400,
          description: "Invalid attribute specified.",
          detail: { validAttributes: ["_id", "_type", "clientId"] },
        }),
      )
      .mockResolvedValue("created");
    const r = await runExecute(client({ writeSocialIdp }), "alpha", [
      item(
        comp({
          kind: "socialIdp",
          id: "g",
          raw: { _id: "g", _type: { _id: "oidcConfig" }, clientId: "c", clientSecret: "x" },
        }),
        { secret: "sek" },
      ),
    ]);
    expect(r[0].status).toBe("created");
    expect(writeSocialIdp).toHaveBeenCalledTimes(2); // first 400 → strip → retry
  });

  it("skips an idp that needs a secret when none was supplied (no write call)", async () => {
    const writeSocialIdp = vi.fn(() => Promise.resolve("created" as const));
    const r = await runExecute(client({ writeSocialIdp }), "alpha", [
      item(
        comp({
          kind: "socialIdp",
          id: "g",
          raw: { _id: "g", _type: { _id: "oidcConfig" }, clientSecret: null },
        }),
      ),
    ]);
    expect(r[0].status).toBe("skipped");
    expect(writeSocialIdp).not.toHaveBeenCalled();
  });

  it("writes an idp when the secret is supplied (drops _type, sets secret)", async () => {
    const writeSocialIdp = vi.fn(() => Promise.resolve("created" as const));
    const r = await runExecute(client({ writeSocialIdp }), "alpha", [
      item(
        comp({
          kind: "socialIdp",
          id: "g",
          raw: { _id: "g", _type: { _id: "oidcConfig" }, clientSecret: null },
        }),
        { secret: "x" },
      ),
    ]);
    expect(r[0].status).toBe("created");
    expect(writeSocialIdp).toHaveBeenCalledWith(
      "alpha",
      "oidcConfig",
      "g",
      expect.objectContaining({ clientSecret: "x" }),
    );
  });

  it("a throwing write → failed with the message", async () => {
    const r = await runExecute(
      client({ writeTheme: () => Promise.reject(new Error("boom")) }),
      "alpha",
      [item(comp({ kind: "theme" }))],
    );
    expect(r[0].status).toBe("failed");
    expect(r[0].message).toContain("boom");
  });

  it("writes sequentially (themes splice the same doc → never parallel)", async () => {
    const order: string[] = [];
    const writeTheme = vi.fn(async (_realm: string, t: Record<string, unknown>) => {
      order.push(`start:${t._id}`);
      await Promise.resolve();
      order.push(`end:${t._id}`);
      return "created" as const;
    });
    await runExecute(client({ writeTheme }), "alpha", [
      item(comp({ id: "a", raw: { _id: "a" } })),
      item(comp({ id: "b", raw: { _id: "b" } })),
    ]);
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });

  it("writes an ESV variable directly (no secret needed) → created", async () => {
    const writeEsvVariable = vi.fn(() => Promise.resolve("created" as const));
    const r = await runExecute(client({ writeEsvVariable }), "alpha", [
      item(comp({ kind: "variable", id: "esv-x", raw: { _id: "esv-x", valueBase64: "dg==" } })),
    ]);
    expect(r[0].status).toBe("created");
    expect(writeEsvVariable).toHaveBeenCalledWith(
      "esv-x",
      expect.objectContaining({ valueBase64: "dg==" }),
    );
  });

  it("writes an ESV secret with the supplied value, base64-encoded", async () => {
    const writeEsvSecret = vi.fn((_id: string, _body: Record<string, unknown>) =>
      Promise.resolve("created" as const),
    );
    const r = await runExecute(client({ writeEsvSecret }), "alpha", [
      item(comp({ kind: "secret", id: "esv-s", raw: { _id: "esv-s", encoding: "generic" } }), {
        secret: "topsecret",
      }),
    ]);
    expect(r[0].status).toBe("created");
    const body = writeEsvSecret.mock.calls[0][1] as { valueBase64: string };
    expect(Buffer.from(body.valueBase64, "base64").toString("utf8")).toBe("topsecret");
  });

  it("skips an ESV secret with no supplied value (no write call)", async () => {
    const writeEsvSecret = vi.fn(() => Promise.resolve("created" as const));
    const r = await runExecute(client({ writeEsvSecret }), "alpha", [
      item(comp({ kind: "secret", id: "esv-s", raw: { _id: "esv-s" } })),
    ]);
    expect(r[0].status).toBe("skipped");
    expect(writeEsvSecret).not.toHaveBeenCalled();
  });

  it("maps a secret 400 'already exists' to skipped, not failed", async () => {
    const writeEsvSecret = vi.fn(() =>
      Promise.reject(new PaicError("bad", { status: 400, description: "secret already exists" })),
    );
    const r = await runExecute(client({ writeEsvSecret }), "alpha", [
      item(comp({ kind: "secret", id: "esv-s", raw: { _id: "esv-s" } }), { secret: "v" }),
    ]);
    expect(r[0].status).toBe("skipped");
    expect(r[0].message).toMatch(/already present/);
  });

  it("a genuine secret 400 (not already-exists) → failed", async () => {
    const writeEsvSecret = vi.fn(() =>
      Promise.reject(new PaicError("bad", { status: 400, description: "invalid base64" })),
    );
    const r = await runExecute(client({ writeEsvSecret }), "alpha", [
      item(comp({ kind: "secret", id: "esv-s", raw: { _id: "esv-s" } }), { secret: "v" }),
    ]);
    expect(r[0].status).toBe("failed");
  });

  it("writes a decision script by uuid with the re-encoded body → created", async () => {
    const writeScript = vi.fn(() => Promise.resolve("created" as const));
    const r = await runExecute(client({ writeScript }), "alpha", [
      item(
        comp({
          kind: "script",
          id: "s-uuid",
          raw: {
            _id: "s-uuid",
            name: "helpers",
            script: JSON.stringify("// x"),
            language: "JAVASCRIPT",
          },
        }),
      ),
    ]);
    expect(r[0].status).toBe("created");
    expect(writeScript).toHaveBeenCalledTimes(1);
    const [realm, id, body] = writeScript.mock.calls[0] as unknown as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(realm).toBe("alpha");
    expect(id).toBe("s-uuid");
    expect(Buffer.from(body.script as string, "base64").toString("utf8")).toBe("// x");
  });

  it("writes a library script with context LIBRARY round-tripping → overwritten", async () => {
    const writeScript = vi.fn(() => Promise.resolve("overwritten" as const));
    const r = await runExecute(client({ writeScript }), "alpha", [
      item(
        comp({
          kind: "script",
          id: "lib-uuid",
          raw: { _id: "lib-uuid", name: "util", context: "LIBRARY", script: JSON.stringify("1") },
        }),
        { verdict: "differs" },
      ),
    ]);
    expect(r[0].status).toBe("overwritten");
    const body = (writeScript.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(body.context).toBe("LIBRARY");
  });

  it("a throwing writeScript → failed with the error message", async () => {
    const writeScript = vi.fn(() => Promise.reject(new Error("boom")));
    const r = await runExecute(client({ writeScript }), "alpha", [
      item(comp({ kind: "script", id: "s", raw: { _id: "s", script: JSON.stringify("x") } })),
    ]);
    expect(r[0].status).toBe("failed");
    expect(r[0].message).toBe("boom");
  });

  it("reconciles the write to resolvedTargetId when set (overwrite in place, TD-9)", async () => {
    const writeScript = vi.fn(() => Promise.resolve("overwritten" as const));
    await runExecute(client({ writeScript }), "alpha", [
      item(
        comp({
          kind: "script",
          id: "bundle-uuid",
          raw: { _id: "bundle-uuid", script: JSON.stringify("x") },
        }),
        {
          verdict: "differs",
          resolvedTargetId: "target-uuid",
        },
      ),
    ]);
    const [, id, body] = writeScript.mock.calls[0] as unknown as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(id).toBe("target-uuid"); // URL resource id = the target uuid (NOT the bundle uuid)
    // AM requires the body `_id` to match the URL id — realign it on reconcile,
    // else "Script resource id and script JSON body id do not match" (live bug).
    expect(body._id).toBe("target-uuid");
  });

  it("falls back to the bundle uuid on a true create (no resolvedTargetId)", async () => {
    const writeScript = vi.fn(() => Promise.resolve("created" as const));
    await runExecute(client({ writeScript }), "alpha", [
      item(
        comp({
          kind: "script",
          id: "bundle-uuid",
          raw: { _id: "bundle-uuid", script: JSON.stringify("x") },
        }),
      ),
    ]);
    const id = (writeScript.mock.calls[0] as unknown[])[1] as string;
    expect(id).toBe("bundle-uuid");
  });
});
