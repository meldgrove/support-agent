import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigForTests } from "../config";
import { callUpdater } from "./client";

/** Answers captured from Updater 0.2 (against GHCR and GitHub). */
const FIXTURES = new URL("../test/fixtures/updater-0.2/", import.meta.url);
const samples = readdirSync(FIXTURES)
  .filter((name) => name.endsWith(".json"))
  .map((name) => ({ name, text: readFileSync(new URL(name, FIXTURES), "utf8") }));

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  process.env.UPDATER_URL = "http://updater.test:8080";
  resetConfigForTests();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.UPDATER_URL;
  resetConfigForTests();
});

describe("the real answers of Updater 0.2", () => {
  it("has samples", () => {
    expect(samples.length).toBeGreaterThanOrEqual(7);
  });

  it.each(samples)("reads $name with every field", async ({ name, text }) => {
    const install = name.startsWith("install-");
    const httpStatus = install ? 202 : 200;
    fetchMock.mockResolvedValueOnce(
      new Response(text, { status: httpStatus, headers: { "content-type": "application/json" } }),
    );

    const result = install ? await callUpdater("install", { version: "0.1.3" }) : await callUpdater("status");

    // toEqual: a field the schema does not know would be missing here.
    expect(result).toEqual({ kind: "ok", httpStatus, status: JSON.parse(text) });
  });
});
