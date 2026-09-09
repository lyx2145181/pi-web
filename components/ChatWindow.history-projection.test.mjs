import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { createJiti } from "jiti";

const text = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const source = ts.createSourceFile("ChatWindow.tsx", text, ts.ScriptTarget.Latest, true);
const jiti = createJiti(import.meta.url);
const display = await jiti.import("../lib/message-display.ts");
const files = await jiti.import("../lib/turn-written-files.ts");
const names = ["hasFinalAssistantAnswer", "findFinalAssistantIndex", "withAssistantBlocks", "prepareHistoryTurns"];
const helpers = names.map((name) => {
  const node = source.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name);
  return node.getText(source);
}).join("\n");
const context = vm.createContext({ ...display, ...files });
vm.runInContext(ts.transpileModule(helpers, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText, context);
const prepare = context.prepareHistoryTurns;
const user = (value) => ({ role: "user", content: value });
const assistant = (content, extra = {}) => ({ role: "assistant", content, usage: { input: 12 }, ...extra });
const answer = { type: "text", text: "最终回复" };

function plain(value) { return JSON.parse(JSON.stringify(value)); }

test("history projection preserves answers, deferred block indices, usage and successful written files", () => {
  const empty = { type: "thinking", thinking: "" };
  const thinking = { type: "thinking", thinking: "", deferred: true };
  const tool = { type: "toolCall", toolName: "write", toolCallId: "write-1", input: { path: "note.md" } };
  const process = assistant([tool]);
  const final = assistant([empty, thinking, answer]);
  const messages = [user("问题"), process, { role: "toolResult", toolCallId: "write-1", isError: false }, final];
  const before = JSON.stringify(messages);
  const turn = prepare(messages, new Map([["write-1", messages[2]]]), "/project").get(0);
  assert.equal(turn.finalAssistantIdx, 3);
  assert.deepEqual(plain(turn.finalAnswerMessage.content), [answer]);
  assert.equal(turn.finalAnswerMessage.usage, final.usage);
  assert.deepEqual(plain(turn.finalProcessMessage.content), [empty, thinking]);
  assert.equal(turn.finalProcessMessage.content[1], thinking);
  assert.equal(turn.finalProcessMessage.usage, undefined);
  assert.deepEqual(plain(turn.writtenFiles), [{ filePath: "/project/note.md" }]);
  assert.equal(JSON.stringify(messages), before);
});

test("history projection keeps compaction groups, images, errors and process-only turns", () => {
  const image = { type: "image", data: "image-data", mimeType: "image/png" };
  const thinking = { type: "thinking", thinking: "执行过程" };
  const onlyProcess = assistant([thinking]);
  const messages = [assistant([answer]), user("无回复"), { role: "custom", customType: "compaction", content: "摘要" }, assistant([image]), user("仅过程"), onlyProcess, user("错误"), assistant([thinking], { stopReason: "error", errorMessage: "terminated" }), user("待回复")];
  const turns = prepare(messages, new Map());
  assert.deepEqual([...turns.keys()], [2, 4, 6]);
  assert.deepEqual(plain(turns.get(2).finalAnswerMessage.content), [image]);
  assert.equal(turns.get(4).finalAnswerMessage, null);
  assert.equal(turns.get(4).finalProcessMessage.usage, onlyProcess.usage);
  assert.equal(turns.get(6).finalAnswerMessage.errorMessage, "terminated");
  assert.deepEqual(plain(turns.get(6).finalAnswerMessage.content), []);
});

test("memoized projections retain identity on unrelated updates and refresh for every relevant input", () => {
  const nodes = [];
  function visit(node) { nodes.push(node); ts.forEachChild(node, visit); }
  visit(source);
  const declaration = nodes.find((n) => ts.isVariableDeclaration(n) && n.name.getText(source) === "historyTurns");
  assert.ok(declaration);
  let previous;
  const run = new vm.Script(ts.transpileModule(declaration.initializer.getText(source), { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText);
  const tool = { type: "toolCall", toolName: "edit", toolCallId: "edit-1", input: { path: "note.md" } };
  const scope = vm.createContext({
    prepareHistoryTurns: prepare,
    messages: [user("问题"), assistant([tool]), assistant([answer])],
    toolResultsMap: new Map(), messageCwd: "/first",
    useMemo: (fn, deps) => {
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) previous = { deps, value: fn() };
      return previous.value;
    },
  });
  const first = run.runInContext(scope);
  const second = run.runInContext(scope);
  assert.equal(first, second);
  assert.equal(first.get(0).finalAnswerMessage, second.get(0).finalAnswerMessage);
  assert.equal(first.get(0).finalProcessMessage, second.get(0).finalProcessMessage);
  assert.equal(first.get(0).writtenFiles, second.get(0).writtenFiles);
  assert.deepEqual(plain(first.get(0).writtenFiles), []);
  scope.toolResultsMap = new Map([["edit-1", { isError: false }]]);
  const succeeded = run.runInContext(scope);
  assert.notEqual(first, succeeded);
  assert.deepEqual(plain(succeeded.get(0).writtenFiles), [{ filePath: "/first/note.md" }]);
  scope.messageCwd = "/second";
  assert.deepEqual(plain(run.runInContext(scope).get(0).writtenFiles), [{ filePath: "/second/note.md" }]);
  scope.toolResultsMap = new Map([["edit-1", { isError: true }]]);
  assert.deepEqual(plain(run.runInContext(scope).get(0).writtenFiles), []);
  scope.messages = [user("新回复"), assistant([{ type: "text", text: "更新后的内容" }])];
  assert.equal(run.runInContext(scope).get(0).finalAnswerMessage.content[0].text, "更新后的内容");
  assert.match(text, /const completedTurn = historyTurns\.get\(userIdx\)/);
  assert.match(text, /if \(isLiveTail\) \{[\s\S]*?rendered\.push\(renderMessage\(renderIdx\)\)/);
});
