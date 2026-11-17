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
