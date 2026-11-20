import { expect, test } from "bun:test";
import { route } from "./route";

test("at the root of a domain (Vercel)", () => {
  expect(route("/", "/")).toBe("");
  expect(route("/host", "/")).toBe("host");
  expect(route("/screen/", "/")).toBe("screen");
});

test("in a folder (GitHub Pages)", () => {
  expect(route("/mixer/", "/mixer/")).toBe("");
  expect(route("/mixer/host/", "/mixer/")).toBe("host");
  expect(route("/mixer/screen", "/mixer/")).toBe("screen");
  expect(route("/mixer/screen/index.html", "/mixer/")).toBe("screen");
});
