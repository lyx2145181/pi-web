import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const hook = await readFile(new URL("./useScrollbarVisibility.ts", import.meta.url), "utf8");
const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const sidebar = await readFile(new URL("../components/SessionSidebar.tsx", import.meta.url), "utf8");
const chat = await readFile(new URL("../components/ChatWindow.tsx", import.meta.url), "utf8");

test("shows subtle scrollbars on pointer or scroll and releases every listener and timer", () => {
  assert.match(hook, /const HIDE_DELAY_MS = 500/);
  assert.match(hook, /element\.addEventListener\("pointerenter", show\)/);
  assert.match(hook, /element\.addEventListener\("pointerleave", hideSoon\)/);
  assert.match(hook, /element\.addEventListener\("scroll", onScroll\)/);
  assert.match(hook, /const onScroll = \(\) => \{\s*show\(\);\s*hideSoon\(\)/);
  assert.match(hook, /if \(attachFrame !== null\) cancelAnimationFrame\(attachFrame\)/);
  assert.match(hook, /element\?\.removeEventListener\("pointerenter", show\)/);
  assert.match(hook, /element\?\.removeEventListener\("pointerleave", hideSoon\)/);
  assert.match(hook, /element\?\.removeEventListener\("scroll", onScroll\)/);
  assert.match(hook, /clearHideTimer\(\);\s*element\?\.classList\.remove\("scrollbar-visible"\)/);
});

test("scopes transparent thumbs to chat, session list and explorer without changing terminal or mobile grab targets", () => {
  assert.match(css, /\.scrollbar-subtle::-webkit-scrollbar-thumb \{\s*background-color: transparent/);
  assert.match(css, /\.scrollbar-subtle\.scrollbar-visible::-webkit-scrollbar-thumb \{\s*background-color: color-mix/);
  assert.match(css, /\.terminal-xterm \.xterm-viewport::-webkit-scrollbar-thumb \{/);
  assert.match(css, /@media \(pointer: coarse\) \{[\s\S]*?::-webkit-scrollbar \{\s*width: 6px/);
  assert.match(chat, /useScrollbarVisibility\(scrollContainerRef, Boolean\(session\?\.id\) \|\| !isEmptyNew\)/);
  assert.match(chat, /className="scrollbar-subtle min-w-0 flex-1 overflow-x-hidden overflow-y-auto pt-4 \[scrollbar-gutter:stable\]"/);
  assert.match(sidebar, /useScrollbarVisibility\(listScrollRef\)/);
  assert.match(sidebar, /useScrollbarVisibility\(explorerScrollRef, explorerOpen && Boolean\(selectedCwdProp \|\| selectedCwd\)\)/);
  assert.match(sidebar, /ref=\{listScrollRef\}[\s\S]*?className="scrollbar-subtle"/);
  assert.match(sidebar, /ref=\{explorerScrollRef\} className="scrollbar-subtle"/);
  assert.match(sidebar, /data-resize-handle="sidebar-sections"/);
});
