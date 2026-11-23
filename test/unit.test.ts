import { describe, expect, it } from "vitest";
import { Ant0ApiError } from "../src/api/index.js";
import { describeError, UsageError } from "../src/errors.js";
import { flatten, keyValues, table } from "../src/format.js";
import { parseSetArgs, parseSetValue } from "../src/set.js";

describe("--set parsing", () => {
  it("builds nested objects from dotted keys", () => {
    expect(
      parseSetArgs([
        "network.geo.timezone=Europe/Berlin",
        "network.geo.latitude=52.5",
        "pinned=true",
        "group=null",
        "name=Alice",
      ]),
    ).toEqual({
      network: { geo: { timezone: "Europe/Berlin", latitude: 52.5 } },
      pinned: true,
      group: null,
      name: "Alice",
    });
  });

  it("parses comma lists, array paths and JSON", () => {
    expect(parseSetValue("a,b", "tags")).toEqual(["a", "b"]);
    expect(parseSetValue("solo", "tags")).toEqual(["solo"]);
    expect(parseSetValue("", "tags")).toEqual([]);
    expect(parseSetValue("1,2", "x")).toEqual([1, 2]);
    expect(parseSetValue('"1,2"', "notes")).toBe("1,2");
    expect(parseSetValue('{"width":1,"height":2}', "launch.window")).toEqual({
      width: 1,
      height: 2,
    });
    expect(parseSetValue("[]", "launch.extra_args")).toEqual([]);
    expect(parseSetValue("0042", "status")).toBe(42);
  });

  it("rejects malformed pairs", () => {
    expect(() => parseSetArgs(["novalue"])).toThrow(UsageError);
    expect(() => parseSetArgs(["=x"])).toThrow(UsageError);
    expect(() => parseSetArgs(["bad key=1"])).toThrow(UsageError);
    expect(() => parseSetArgs(["a={oops"])).toThrow(UsageError);
  });
});

describe("format", () => {
  it("table aligns columns and renders null as -", () => {
    expect(
      table(
        ["id", "name"],
        [
          ["1", "a"],
          ["22", null],
        ],
      ),
    ).toBe("ID  NAME\n1   a\n22  -");
    expect(table(["x"], [])).toBe("X");
  });

  it("keyValues pads keys", () => {
    expect(
      keyValues([
        ["a", 1],
        ["long", true],
      ]),
    ).toBe("a     1\nlong  true");
  });

  it("flatten produces dotted paths", () => {
    expect(flatten({ a: { b: 1, c: [1, 2] }, d: [], e: {}, f: null, g: [{ x: 1 }] })).toEqual([
      ["a.b", 1],
      ["a.c", "1, 2"],
      ["d", "[]"],
      ["e", "{}"],
      ["f", null],
      ["g", '[{"x":1}]'],
    ]);
  });
});

describe("describeError", () => {
  it("maps API errors to exit 1 with details for 400", () => {
    const d = describeError(
      new Ant0ApiError(400, "validation_failed", "body invalid", [
        { instancePath: "/launch/start_urls/0", message: 'must match format "uri"' },
        { path: "name", message: "required" },
      ]),
    );
    expect(d.exitCode).toBe(1);
    expect(d.lines).toEqual([
      "validation_failed: body invalid",
      '  launch.start_urls.0: must match format "uri"',
      "  name: required",
    ]);
  });

  it("maps connection refused to exit 3", () => {
    const err = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
    expect(describeError(err).exitCode).toBe(3);
    const aggregate = new TypeError("fetch failed", {
      cause: new AggregateError([Object.assign(new Error("x"), { code: "ECONNREFUSED" })]),
    });
    expect(describeError(aggregate).exitCode).toBe(3);
  });

  it("maps everything else to exit 1", () => {
    expect(describeError(new Error("boom"))).toEqual({ lines: ["boom"], exitCode: 1 });
    expect(describeError("str")).toEqual({ lines: ["str"], exitCode: 1 });
  });
});
