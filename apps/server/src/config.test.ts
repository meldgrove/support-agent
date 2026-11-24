import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { config, resetConfigForTests } from "./config";

const KEYS = ["NODE_ENV", "APP_URL", "AUTH_SECRET", "ENCRYPTION_KEY"] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

/** The values .env.example sets, e.g. AUTH_SECRET. */
function exampleValue(key: string): string {
  const file = readFileSync(path.resolve(import.meta.dirname, "../../../.env.example"), "utf8");
  const value = new RegExp(`^${key}=(.*)$`, "m").exec(file)?.[1]?.trim();
  if (!value) throw new Error(`.env.example has no ${key}`);
  return value;
}

function configWith(values: Partial<Record<(typeof KEYS)[number], string>>) {
  Object.assign(process.env, values);
  resetConfigForTests();
  return () => config();
}

describe("example secrets", () => {
  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    resetConfigForTests();
  });

  const examples = {
    AUTH_SECRET: exampleValue("AUTH_SECRET"),
    ENCRYPTION_KEY: exampleValue("ENCRYPTION_KEY"),
  };

  it("are refused in production", () => {
    expect(configWith({ NODE_ENV: "production", APP_URL: "http://localhost:3000", ...examples })).toThrow(
      /AUTH_SECRET: Replace the example value[\s\S]*ENCRYPTION_KEY: Replace the example value/,
    );
  });

  it("are refused for a public APP_URL, even with NODE_ENV=development", () => {
    expect(
      configWith({ NODE_ENV: "development", APP_URL: "https://support.example.org", ...examples }),
    ).toThrow(/AUTH_SECRET: Replace the example value[\s\S]*ENCRYPTION_KEY: Replace the example value/);
  });

  it("leave an invalid APP_URL to the configuration summary", () => {
    expect(configWith({ NODE_ENV: "development", APP_URL: "not a url", ...examples })).toThrow(
      /Invalid configuration:[\s\S]*APP_URL:/,
    );
  });

  it("are allowed for development on this machine", () => {
    expect(
      configWith({ NODE_ENV: "development", APP_URL: "http://localhost:5173", ...examples })().APP_URL,
    ).toBe("http://localhost:5173");
  });
});

describe("UPDATER_URL", () => {
  afterEach(() => {
    delete process.env.UPDATER_URL;
    resetConfigForTests();
  });

  const updaterUrl = (value: string | undefined) => {
    if (value === undefined) delete process.env.UPDATER_URL;
    else process.env.UPDATER_URL = value;
    resetConfigForTests();
    return config().UPDATER_URL;
  };

  it("defaults to the updater of compose.yaml, and empty switches the button off", () => {
    expect(updaterUrl(undefined)).toBe("http://updater:8080");
    expect(updaterUrl("")).toBe("");
    expect(updaterUrl("  ")).toBe("");
    expect(updaterUrl("http://127.0.0.1:18080/")).toBe("http://127.0.0.1:18080");
  });

  it("must be an http URL", () => {
    expect(() => updaterUrl("updater:8080")).toThrow(/UPDATER_URL/);
    expect(() => updaterUrl("file:///etc/passwd")).toThrow(/UPDATER_URL/);
  });
});

describe("UPDATER_TOKEN", () => {
  afterEach(() => {
    delete process.env.UPDATER_TOKEN;
    resetConfigForTests();
  });

  const updaterToken = (value: string | undefined) => {
    if (value === undefined) delete process.env.UPDATER_TOKEN;
    else process.env.UPDATER_TOKEN = value;
    resetConfigForTests();
    return config().UPDATER_TOKEN;
  };

  it("is optional, and empty means none", () => {
    expect(updaterToken(undefined)).toBeUndefined();
    expect(updaterToken("")).toBeUndefined();
    expect(updaterToken("  ")).toBeUndefined();
    expect(updaterToken("0f1e2d3c4b5a69788796a5b4c3d2e1f0")).toBe("0f1e2d3c4b5a69788796a5b4c3d2e1f0");
  });

  it("takes only visible characters, so the header stays one value", () => {
    expect(() => updaterToken("two words")).toThrow(/UPDATER_TOKEN/);
    expect(() => updaterToken("line\nbreak")).toThrow(/UPDATER_TOKEN/);
  });
});
