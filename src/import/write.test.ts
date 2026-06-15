import { describe, expect, it } from "vitest";
import { type ExportMeta, serializeScript } from "../export/serialize";
import type { RawScript } from "../paic/mappers";
import {
  emailTemplateName,
  idpNeedsSecret,
  scriptBodyToWire,
  toEmailWrite,
  toIdpWrite,
  toScriptWrite,
  toSecretWrite,
  toThemeWrite,
  toVariableWrite,
} from "./write";

const decode = (b64: string): string => Buffer.from(b64, "base64").toString("utf8");
const encode = (s: string): string => Buffer.from(s, "utf8").toString("base64");

const META: ExportMeta = {
  bundleSchemaVersion: "1.0.0",
  origin: "openam-tenant.example.forgeblocks.com",
  connectionType: "paic",
  realm: "alpha",
  exportDate: "2026-06-12T00:00:00.000Z",
  exportTool: "test",
  exportToolVersion: "0.0.0",
};

describe("write transforms", () => {
  it("toEmailWrite strips _id and extracts the bare name from the prefix", () => {
    const { name, body } = toEmailWrite({ _id: "emailTemplate/welcome", subject: { en: "Hi" } });
    expect(name).toBe("welcome");
    expect(body).toEqual({ subject: { en: "Hi" } });
  });

  it("toIdpWrite keeps _id, drops _type, sets the supplied secret", () => {
    const { typeId, id, body } = toIdpWrite(
      { _id: "g", _type: { _id: "oidcConfig" }, clientId: "c", clientSecret: null },
      "s3cret",
    );
    expect(typeId).toBe("oidcConfig");
    expect(id).toBe("g");
    expect(body._id).toBe("g");
    expect(body._type).toBeUndefined();
    expect(body.clientSecret).toBe("s3cret");
  });

  it("toIdpWrite leaves clientSecret untouched when none is supplied", () => {
    const { body } = toIdpWrite({ _id: "g", _type: { _id: "x" }, clientSecret: null }, undefined);
    expect(body.clientSecret).toBeNull();
  });

  it("toIdpWrite defaults an empty scopeDelimiter to a space (on-prem AM requires it)", () => {
    const { body } = toIdpWrite({ _id: "g", _type: { _id: "x" }, scopeDelimiter: "" }, undefined);
    expect(body.scopeDelimiter).toBe(" ");
  });

  it("toIdpWrite leaves a non-empty scopeDelimiter untouched", () => {
    const { body } = toIdpWrite({ _id: "g", _type: { _id: "x" }, scopeDelimiter: "," }, undefined);
    expect(body.scopeDelimiter).toBe(",");
  });

  it("toThemeWrite drops linkedTrees, keeps content + _id", () => {
    const out = toThemeWrite({ _id: "t", linkedTrees: ["A"], backgroundColor: "#1" });
    expect(out.linkedTrees).toBeUndefined();
    expect(out.backgroundColor).toBe("#1");
    expect(out._id).toBe("t");
  });

  it("idpNeedsSecret is true only when a clientSecret key is present", () => {
    expect(idpNeedsSecret({ clientSecret: null })).toBe(true);
    expect(idpNeedsSecret({ clientId: "c" })).toBe(false);
  });

  it("emailTemplateName strips the prefix and is a no-op without it", () => {
    expect(emailTemplateName("emailTemplate/welcome")).toBe("welcome");
    expect(emailTemplateName("welcome")).toBe("welcome");
  });
});

describe("ESV write transforms", () => {
  it("toVariableWrite keeps writable fields, drops server fields + _id", () => {
    const out = toVariableWrite({
      _id: "esv-x",
      valueBase64: "dmFs",
      expressionType: "string",
      description: "d",
      lastChangeDate: "2026",
      lastChangedBy: "sa",
      loaded: false,
    });
    expect(out).toEqual({ valueBase64: "dmFs", expressionType: "string", description: "d" });
  });

  it("toSecretWrite base64-encodes the plaintext exactly once + keeps encoding", () => {
    const out = toSecretWrite(
      { _id: "esv-s", encoding: "generic", useInPlaceholders: true, loaded: false },
      "s3cret-value",
    );
    expect(decode(out.valueBase64 as string)).toBe("s3cret-value"); // single encode round-trips
    expect(out.encoding).toBe("generic");
    expect(out.useInPlaceholders).toBe(true);
    expect(out._id).toBeUndefined();
    expect(out.loaded).toBeUndefined();
  });
});

describe("script write transforms", () => {
  const SRC = "// hi\nlogger.message('x');";

  it("scriptBodyToWire decodes the JSON-stringified source then base64-encodes", () => {
    expect(decode(scriptBodyToWire(JSON.stringify(SRC)))).toBe(SRC);
  });

  it("toScriptWrite keeps _id/name/language/context, drops audit fields", () => {
    const out = toScriptWrite({
      _id: "s-uuid",
      name: "helpers",
      language: "JAVASCRIPT",
      context: "LIBRARY",
      script: JSON.stringify(SRC),
      _rev: "9",
      createdBy: "sa",
      creationDate: 1,
      lastModifiedBy: "sa",
      lastModifiedDate: 2,
      evaluatorVersion: "2.0",
    });
    expect(out._id).toBe("s-uuid");
    expect(out.name).toBe("helpers");
    expect(out.language).toBe("JAVASCRIPT");
    expect(out.context).toBe("LIBRARY"); // library context round-trips
    expect(out._rev).toBeUndefined();
    expect(out.createdBy).toBeUndefined();
    expect(out.evaluatorVersion).toBeUndefined();
  });

  it("toScriptWrite re-encodes the body to base64", () => {
    const out = toScriptWrite({ _id: "s", script: JSON.stringify(SRC) });
    expect(decode(out.script as string)).toBe(SRC);
  });

  it("toScriptWrite round-trips serializeScript output (forward ∘ inverse = identity)", () => {
    const raw: RawScript = {
      _id: "s-uuid",
      name: "helpers",
      language: "JAVASCRIPT",
      script: encode(SRC), // wire form: base64
    };
    const bundled = serializeScript(raw, META).script?.["s-uuid"] as Record<string, unknown>;
    const out = toScriptWrite(bundled);
    expect(decode(out.script as string)).toBe(SRC);
    expect(out._id).toBe("s-uuid");
  });

  it("toScriptWrite leaves a non-string body untouched", () => {
    const out = toScriptWrite({ _id: "s", script: 42 });
    expect(out.script).toBe(42);
  });
});
