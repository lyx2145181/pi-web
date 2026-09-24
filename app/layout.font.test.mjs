import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

const layout = await readFile(new URL("./layout.tsx", import.meta.url), "utf8");

test("self-hosts the complete Noto Sans SC variable font without changing Geist or the CSS variable", async () => {
  assert.match(layout, /import \{ Geist, Geist_Mono \} from "next\/font\/google"/);
  assert.match(layout, /import localFont from "next\/font\/local"/);
  assert.match(layout, /src: "\.\/fonts\/NotoSansSC-variable\.ttf"/);
  assert.match(layout, /weight: "100 900"/);
  assert.match(layout, /variable: "--font-noto-sans-sc"/);
  assert.doesNotMatch(layout, /Noto_Sans_SC\(/);

  const font = await stat(new URL("./fonts/NotoSansSC-variable.ttf", import.meta.url));
  assert.equal(font.size, 17_772_300);
  const license = await readFile(new URL("./fonts/OFL.txt", import.meta.url), "utf8");
  assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/);
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(pkg.files.includes("app/fonts/OFL.txt"), "the font license must ship with the npm package");
});
