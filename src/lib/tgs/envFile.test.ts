import { describe, expect, it } from "vitest";

import { mergeEnvNonDestructive, parseEnv, renderEnv } from "@/lib/tgs/envFile";

describe("parseEnv", () => {
  it("parses plain assignments, skipping blank lines and comments", () => {
    const text = [
      "# local testing secrets",
      "",
      "WEATHER_API_KEY=sk-123",
      "   ",
      "SLACK_WEBHOOK_URL=https://hooks.example/abc",
      "# trailing comment line",
    ].join("\n");
    expect(parseEnv(text)).toEqual({
      WEATHER_API_KEY: "sk-123",
      SLACK_WEBHOOK_URL: "https://hooks.example/abc",
    });
  });

  it("accepts the `export KEY=value` form", () => {
    expect(parseEnv("export API_KEY=abc\nexport OTHER = spaced \n")).toEqual({
      API_KEY: "abc",
      OTHER: "spaced",
    });
  });

  it("keeps `=` characters inside the value", () => {
    expect(parseEnv("DSN=postgres://u:p@h/db?a=1&b=2\n")).toEqual({
      DSN: "postgres://u:p@h/db?a=1&b=2",
    });
  });

  it("unquotes double quotes and decodes escapes", () => {
    expect(parseEnv('PRIVATE_KEY="line1\\nline2"\n')).toEqual({ PRIVATE_KEY: "line1\nline2" });
    expect(parseEnv('QUOTED="say \\"hi\\""\n')).toEqual({ QUOTED: 'say "hi"' });
    expect(parseEnv('HASH="a # b"\n')).toEqual({ HASH: "a # b" });
  });

  it("treats single quotes as literal", () => {
    expect(parseEnv("LITERAL='no \\n escape'\n")).toEqual({ LITERAL: "no \\n escape" });
  });

  it("strips a trailing comment from an unquoted value only", () => {
    expect(parseEnv("KEY=value # explanation\n")).toEqual({ KEY: "value" });
    expect(parseEnv("KEY=va#lue\n")).toEqual({ KEY: "va#lue" });
  });

  it("keeps empty values and ignores junk lines", () => {
    expect(parseEnv("EMPTY=\nnot an assignment\n=novalue\n")).toEqual({ EMPTY: "" });
  });

  it("handles CRLF line endings and a BOM", () => {
    expect(parseEnv("﻿A=1\r\nB=2\r\n")).toEqual({ A: "1", B: "2" });
  });
});

describe("renderEnv", () => {
  it("emits one line per declared key, in declaration order", () => {
    expect(renderEnv({ B: "2", A: "1" }, ["A", "B"])).toBe("A=1\nB=2\n");
  });

  it("omits undeclared keys and blanks out unknown declared ones", () => {
    expect(renderEnv({ A: "1", EXTRA: "x" }, ["A", "MISSING"])).toBe("A=1\nMISSING=\n");
  });

  it("quotes values that need it", () => {
    expect(renderEnv({ A: "line1\nline2" }, ["A"])).toBe('A="line1\\nline2"\n');
    expect(renderEnv({ A: 'say "hi"' }, ["A"])).toBe('A="say \\"hi\\""\n');
    expect(renderEnv({ A: "a # b" }, ["A"])).toBe('A="a # b"\n');
  });

  it("round-trips through parseEnv", () => {
    const values = { A: "plain", B: "with space", C: 'q"uote', D: "multi\nline", E: "" };
    const keys = Object.keys(values);
    expect(parseEnv(renderEnv(values, keys))).toEqual(values);
  });

  it("renders nothing when nothing is declared", () => {
    expect(renderEnv({ A: "1" }, [])).toBe("");
  });
});

describe("mergeEnvNonDestructive", () => {
  const declared = ["WEATHER_API_KEY", "SLACK_WEBHOOK_URL", "OPTIONAL_TOKEN"];

  it("fills only empty or absent declared keys", () => {
    const result = mergeEnvNonDestructive(
      { WEATHER_API_KEY: "typed-by-hand", SLACK_WEBHOOK_URL: "" },
      {
        WEATHER_API_KEY: "from-file",
        SLACK_WEBHOOK_URL: "https://hooks.example/abc",
        OPTIONAL_TOKEN: "tok",
      },
      declared,
    );

    expect(result.merged["WEATHER_API_KEY"]).toBe("typed-by-hand");
    expect(result.merged["SLACK_WEBHOOK_URL"]).toBe("https://hooks.example/abc");
    expect(result.merged["OPTIONAL_TOKEN"]).toBe("tok");
    expect(result.filled.sort()).toEqual(["OPTIONAL_TOKEN", "SLACK_WEBHOOK_URL"]);
    expect(result.ignored).toEqual([]);
  });

  it("ignores keys the tool does not declare in config.secrets", () => {
    const result = mergeEnvNonDestructive({}, { SOME_OTHER_KEY: "x", NOPE: "y" }, declared);
    expect(result.merged).toEqual({});
    expect(result.ignored.sort()).toEqual(["NOPE", "SOME_OTHER_KEY"]);
    expect(result.filled).toEqual([]);
  });

  it("never overwrites a non-empty value, even with a longer one", () => {
    const current = { WEATHER_API_KEY: "a" };
    const result = mergeEnvNonDestructive(current, { WEATHER_API_KEY: "bbbbb" }, declared);
    expect(result.merged["WEATHER_API_KEY"]).toBe("a");
    expect(result.filled).toEqual([]);
    expect(current["WEATHER_API_KEY"]).toBe("a"); // input is not mutated
  });

  it("does not count an empty incoming value as a fill", () => {
    const result = mergeEnvNonDestructive(
      { SLACK_WEBHOOK_URL: "" },
      { SLACK_WEBHOOK_URL: "" },
      declared,
    );
    expect(result.filled).toEqual([]);
    expect(result.merged["SLACK_WEBHOOK_URL"]).toBe("");
  });

  it("works end to end from a loaded .env file", () => {
    const loaded = parseEnv("WEATHER_API_KEY=from-file\nUNRELATED=1\n");
    const result = mergeEnvNonDestructive({}, loaded, declared);
    expect(result.merged).toEqual({ WEATHER_API_KEY: "from-file" });
    expect(result.ignored).toEqual(["UNRELATED"]);
    expect(renderEnv(result.merged, declared)).toBe(
      "WEATHER_API_KEY=from-file\nSLACK_WEBHOOK_URL=\nOPTIONAL_TOKEN=\n",
    );
  });
});
