import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const { createSubagentController } = await createJiti(import.meta.url).import("./subagent-runtime.ts");
const { AgentSessionWrapper } = await createJiti(import.meta.url).import("./rpc-manager.ts");
const { createSubagentExtension, subagentFinalText } = await createJiti(import.meta.url).import("./subagent-extension.ts");
const { readSubagentRun } = await createJiti(import.meta.url).import("./subagents.ts");
const { removeWorktree } = await createJiti(import.meta.url).import("./worktree.ts");
const exec = promisify(execFile);

async function withRuntime(check, configureChild, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-subagent-runtime-"));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const sessions = new Map();
  const sessionPaths = new Map();
  let worktrees;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    await mkdir(join(dir, "agents"));
    await writeFile(join(dir, "agents", "fixture.md"), [
      "---", "description: Exercise the real subagent lifecycle.", `tools: ${options.tools ?? "read"}`,
      "load_skills: false", "load_extensions: false", "max_turns: 1",
      ...(options.codeMode !== undefined ? [`code_mode: ${options.codeMode}`] : []),
      "---", "Complete the assigned task.",
    ].join("\n"));
    await writeFile(join(dir, "agents", "fixture-unlimited.md"), [
      "---", "description: Exercise a run the profile leaves without a turn limit.", "tools: read",
      "load_skills: false", "load_extensions: false", "---", "Complete the assigned task.",
    ].join("\n"));
    await writeFile(join(dir, "agents", "fixture-profile-options.md"), [
      "---", "description: Exercise the options only a profile decides.", "tools: read",
      "load_skills: false", "load_extensions: false", "thinking: low", "inherit_context: true",
      "---", "Complete the assigned task.",
    ].join("\n"));
    await writeFile(join(dir, "agents", "fixture-model-level.md"), [
      "---", "description: Exercise a profile model with a thinking level.", "tools: read",
      "load_skills: false", "load_extensions: false", "model: faux/faux-model:high",
      "---", "Complete the assigned task.",
    ].join("\n"));
    await writeFile(join(dir, "agents", "fixture-model-level-thinking.md"), [
      "---", "description: Exercise a profile thinking level beside a model level.", "tools: read",
      "load_skills: false", "load_extensions: false", "model: faux/faux-model:high", "thinking: minimal",
      "---", "Complete the assigned task.",
    ].join("\n"));
    if (options.settings) await writeFile(join(dir, "settings.json"), JSON.stringify(options.settings));
    const fact = join(dir, "fact.txt");
    await writeFile(fact, "The fixture value is 42.\n");
    if (options.repo) {
      // A git checkout, so a run with `isolation: "worktree"` gets one beside it.
      worktrees = `${await realpath(dir)}-worktrees`;
      for (const args of [["init", "-q"], ["config", "user.email", "test@example.com"], ["config", "user.name", "Pi Web Test"],
        ["add", "fact.txt"], ["commit", "-qm", "initial"]]) await exec("git", ["-C", dir, ...args]);
    }
    const faux = fauxProvider({ models: [
      { id: "faux-model", reasoning: true }, { id: "tuned:high", reasoning: true }, { id: "small-window", contextWindow: 8_000 },
    ] });
    const modelRuntime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"), modelsPath: options.modelsFile ? join(dir, "models.json") : null, refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    const services = await createAgentSessionServices({
      cwd: dir, agentDir: dir, modelRuntime, settingsManager: SettingsManager.inMemory(),
      resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      },
    });
    const { session: parent } = await createAgentSessionFromServices({
      services, sessionManager: SessionManager.create(dir, join(dir, "sessions")), model: faux.getModel("faux-model"),
    });
    const registerSession = (inner, options) => {
      if (inner === parent) {
        const wrapper = {
          inner, cwd: dir, sessionFile: inner.sessionFile ?? "", isAlive: () => true,
          isRunning: () => inner.isStreaming, waitUntilReady: async () => {},
        };
        sessions.set(inner.sessionId, wrapper);
        return wrapper;
      }
      configureChild?.(inner);
      // Our v3 Code mode/MCP children prompt through the wrapper's delegated readiness path, so
      // the fixture registers a real AgentSessionWrapper rather than a plain host stub.
      const wrapper = new AgentSessionWrapper(inner, options ?? {});
      wrapper.start();
      wrapper.beginExtensionBinding();
      sessions.set(inner.sessionId, wrapper);
      sessionPaths.set(inner.sessionId, inner.sessionFile);
      return wrapper;
    };
    registerSession(parent);
    if (options.parentCodemode) {
      const parentTools = parent.getActiveToolNames.bind(parent);
      parent.getActiveToolNames = () => [...new Set([...parentTools(), "codemode"])] ;
    }
    const controller = createSubagentController({
      getSession: (id) => sessions.get(id), registerSession,
      resolveSessionPath: async (id) => {
        const path = sessionPaths.get(id) ?? sessions.get(id)?.sessionFile;
        return path && existsSync(path) ? path : null;
      },
      reopenSession: async () => { throw new Error("The fixture must use its live session."); },
      invalidateSessionList() {}, isBuiltInSubagentsEnabled: () => true,
    });
    const request = {
      parentContext: { sessionManager: parent.sessionManager }, parentToolCallId: "fixture-call",
      profile: "fixture", task: "Read the fixture if necessary and report the result.",
      description: "Lifecycle fixture", runInBackground: false,
    };
    await check({ controller, runtime: controller.extensionRuntime, request, faux, fact, sessions, dir, modelRuntime });
  } finally {
    for (const wrapper of sessions.values()) {
      try { await wrapper.shutdown?.(); } catch { /* best effort */ }
      wrapper.inner.dispose();
    }
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(dir, { recursive: true, force: true });
    if (worktrees) await rm(worktrees, { recursive: true, force: true });
  }
}

const answer = (text) => fauxAssistantMessage([fauxText(text)]);
const readFact = (path, text) => fauxAssistantMessage([
  ...(text ? [fauxText(text)] : []), fauxToolCall("read", { path }),
], { stopReason: "toolUse" });

const codemodeScript = (fact, target) => `
const readResult = await tools.read({ path: ${JSON.stringify(fact)} });
let writeError;
try {
  await tools.write({ path: ${JSON.stringify(target)}, content: "must not be written" });
} catch (error) {
  writeError = String(error);
}
return JSON.stringify({ readResult, writeError });
`;

test("codemode subagents use the sandbox and keep the profile allowlist", async () => {
  await withRuntime(async ({ runtime, request, faux, fact, sessions }) => {
    const target = `${fact}.write-attempt`;
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("codemode", { code: codemodeScript(fact, target) })], { stopReason: "toolUse" }),
      answer("CODEMODE_DONE"),
    ]);
    const execution = await runtime.start(request);
    const result = await execution.completion;
    assert.equal(result.status, "completed", `codemode child failed: ${result.error}`);
    assert.equal(result.result, "CODEMODE_DONE");
    const child = sessions.get(result.sessionId).inner;
    const codemodeResult = child.agent.state.messages.findLast(
      (message) => message.role === "toolResult" && message.toolName === "codemode",
    );
    const output = codemodeResult.content.map((block) => block.text ?? "").join("");
    assert.match(output, /42/);
    assert.match(output, /tools\.write does not exist/);
    assert.equal(existsSync(target), false);
  }, undefined, { codeMode: true });
});

// D2: Code mode is an independent, default-off boolean. A parent with codemode never grants it
// to a child, and the child never inherits it.
test("Code mode is an independent default-off capability that never inherits", async (t) => {
  await t.test("the profile's code_mode enables codemode", async () => {
    await withRuntime(async ({ runtime, request, faux, sessions }) => {
      faux.setResponses([answer("ENABLED")]);
      const execution = await runtime.start(request);
      const result = await execution.completion;
      assert.equal(result.status, "completed");
      assert.ok(sessions.get(result.sessionId).inner.getActiveToolNames().includes("codemode"));
    }, undefined, { codeMode: true });
  });
  await t.test("missing code_mode stays disabled even when the parent has codemode", async () => {
    await withRuntime(async ({ runtime, request, faux, sessions }) => {
      faux.setResponses([answer("DEFAULT_OFF")]);
      const execution = await runtime.start(request);
      const result = await execution.completion;
      assert.equal(result.status, "completed");
      assert.equal(sessions.get(result.sessionId).inner.getActiveToolNames().includes("codemode"), false);
    }, undefined, { parentCodemode: true });
  });
  await t.test("an explicit false stays off even when the parent has codemode", async () => {
    await withRuntime(async ({ runtime, request, faux, sessions }) => {
      faux.setResponses([answer("OFF")]);
      const execution = await runtime.start(request);
      const result = await execution.completion;
      assert.equal(result.status, "completed");
      assert.equal(sessions.get(result.sessionId).inner.getActiveToolNames().includes("codemode"), false);
    }, undefined, { parentCodemode: true, codeMode: false });
  });
  await t.test("a chat-only profile never becomes a scripting session", async () => {
    await withRuntime(async ({ runtime, request, faux, sessions }) => {
      faux.setResponses([answer("CHAT_ONLY")]);
      const execution = await runtime.start(request);
      const result = await execution.completion;
      const child = sessions.get(result.sessionId);
      assert.equal(result.status, "completed");
      assert.equal(child.inner.getActiveToolNames().includes("codemode"), false);
      assert.equal(child.inner.getActiveToolNames().length, 0);
    }, undefined, { parentCodemode: true, tools: "none" });
  });
});

test("codemode only hides direct declarations while keeping scripts callable", async () => {
  await withRuntime(async ({ runtime, request, faux, fact, sessions }) => {
    let declared;
    faux.setResponses([(context) => {
      declared = getCurrentTools(context.messages).map((tool) => tool.name);
      return fauxAssistantMessage([fauxToolCall("codemode", {
        code: `return await tools.read({ path: ${JSON.stringify(fact)} });`,
      })], { stopReason: "toolUse" });
    }, answer("ONLY_MODE")]);
    const execution = await runtime.start(request);
    const result = await execution.completion;
    const child = sessions.get(result.sessionId).inner;
    const codemodeResult = child.agent.state.messages.findLast(
      (message) => message.role === "toolResult" && message.toolName === "codemode",
    );
    assert.equal(result.status, "completed");
    assert.match(codemodeResult.content.map((block) => block.text ?? "").join(""), /42/);
    assert.ok(child.getActiveToolNames().includes("read"));
    assert.ok(child.getActiveToolNames().includes("codemode"));
    assert.ok(declared.includes("codemode"));
    assert.equal(declared.includes("read"), false);
  }, undefined, { codeMode: true, settings: { codemode: { mode: "only" } } });
});

const hasLimitPrompt = (context) => context.messages.some((message) =>
  message.role === "user" && message.content.some((block) =>
    block.type === "text" && block.text.includes("You have reached your turn limit")));

test("turn limits preserve completed results and stop unfinished work at the real SDK boundary", async (t) => {
  await t.test("a final answer at the limit does not request another answer or leak into resume", async () => {
    await withRuntime(async ({ runtime, request, faux }) => {
      faux.setResponses([
        answer("FIRST_RESULT"),
        (context) => {
          assert.equal(hasLimitPrompt(context), false, "No stale budget instruction may enter the resumed task.");
          return answer("RESUMED_RESULT");
        },
      ]);
      const first = await runtime.start(request);
      const completed = await first.completion;
      assert.equal(completed.status, "completed");
      assert.equal(completed.result, "FIRST_RESULT");
      const resumed = await runtime.resume({ ...request, sessionId: completed.sessionId, task: "Report again." });
      const result = await resumed.completion;
      assert.equal(result.status, "completed");
      assert.equal(result.result, "RESUMED_RESULT");
    });
  });

  await t.test("the one wrap-up turn sees its instruction and may finish normally", async () => {
    await withRuntime(async ({ runtime, request, faux, fact }) => {
      faux.setResponses([
        readFact(fact),
        (context) => {
          assert.equal(hasLimitPrompt(context), true, "The instruction must arrive before the wrap-up request.");
          return answer("FINAL_REVIEW");
        },
      ]);
      const execution = await runtime.start(request);
      const result = await execution.completion;
      assert.equal(result.status, "completed");
      assert.equal(result.result, "FINAL_REVIEW");
    });
  });

  await t.test("exhausting the wrap-up turn reports the limit and retains partial output", async () => {
    await withRuntime(async ({ runtime, request, faux, fact }) => {
      faux.setResponses([readFact(fact), readFact(fact, "PARTIAL_FINDINGS")]);
      const execution = await runtime.start(request);
      const result = await execution.completion;
      assert.equal(result.status, "failed");
      assert.match(result.error, /turn limit/i);
      assert.equal(result.result, "PARTIAL_FINDINGS");
      const response = subagentFinalText(result);
      assert.match(response, /failed/i);
      assert.match(response, /PARTIAL_FINDINGS/);
    });
  });
});

const sawText = (context, text) => context.messages.some((message) => message.role === "user" &&
  message.content.some((block) => block.type === "text" && block.text === text));

test("messages queued as the limit ends are reported instead of running past it", async (t) => {
  await t.test("a message from an existing turn hook is not delivered after the limit, nor on resume", async () => {
    await withRuntime(async ({ runtime, request, faux, fact }) => {
      faux.setResponses([
        readFact(fact),
        readFact(fact, "PARTIAL_FINDINGS"),
        answer("PAST_THE_LIMIT"),
      ]);
      const execution = await runtime.start(request);
      const result = await execution.completion;
      assert.equal(faux.state.callCount, 2);
      assert.equal(result.status, "failed");
      assert.match(result.error, /turn limit/i);
      assert.match(result.error, /LATE_HANDOFF/);
      assert.equal(result.result, "PARTIAL_FINDINGS");
      faux.setResponses([(context) => {
        assert.equal(sawText(context, "LATE_HANDOFF"), false, "A reported message must not reach the resumed task.");
        assert.equal(hasLimitPrompt(context), true, "Only the delivered wrap-up instruction stays in the transcript.");
        return answer("RESUMED_RESULT");
      }]);
      const resumed = await runtime.resume({ ...request, sessionId: result.sessionId, task: "Continue." });
      const again = await resumed.completion;
      assert.equal(again.status, "completed");
      assert.equal(again.result, "RESUMED_RESULT");
    }, (inner) => {
      const finishTurn = inner.agent.finishTurn;
      inner.agent.finishTurn = async (turn, signal) => {
        const decision = await finishTurn?.(turn, signal);
        if (!turn.message.content.some((block) => block.type === "text" && block.text === "PARTIAL_FINDINGS")) return decision;
        await inner.steer("LATE_HANDOFF");
        return { action: "continue" };
      };
    });
  });

  await t.test("a steer queued before the wrap-up turn arrives together with the instruction", async () => {
    await withRuntime(async ({ runtime, request, faux, fact }) => {
      let sessionId;
      faux.setResponses([
        async () => {
          await runtime.steer(sessionId, "EARLY_NOTE");
          return readFact(fact);
        },
        (context) => {
          assert.equal(sawText(context, "EARLY_NOTE"), true);
          assert.equal(hasLimitPrompt(context), true, "A queued steer must not hold the instruction back.");
          return answer("FINAL_WITH_NOTE");
        },
        answer("PAST_THE_LIMIT"),
      ]);
      const execution = await runtime.start(request);
      sessionId = execution.run.sessionId;
      const result = await execution.completion;
      assert.equal(faux.state.callCount, 2);
      assert.equal(result.status, "completed");
      assert.equal(result.result, "FINAL_WITH_NOTE");
    });
  });

  await t.test("the parent's steer during the wrap-up turn is reported, and a steer after the limit is refused", async () => {
    await withRuntime(async ({ runtime, request, faux, fact, sessions }) => {
      let sessionId;
      faux.setResponses([
        readFact(fact),
        async () => {
          await runtime.steer(sessionId, "PARENT_NOTE");
          return readFact(fact, "PARTIAL_FINDINGS");
        },
        answer("PAST_THE_LIMIT"),
      ]);
      const execution = await runtime.start(request);
      sessionId = execution.run.sessionId;
      let lateSteer;
      sessions.get(sessionId).inner.subscribe((event) => {
        if (event.type !== "turn_end" || faux.state.callCount !== 2) return;
        lateSteer ??= runtime.steer(sessionId, "TOO_LATE").then(() => "accepted", (error) => error.message);
      });
      const result = await execution.completion;
      assert.equal(faux.state.callCount, 2);
      assert.equal(result.status, "failed");
      assert.match(result.error, /PARENT_NOTE/);
      assert.doesNotMatch(result.error, /You have reached your turn limit/);
      assert.match(await lateSteer, /turn limit/i);
    });
  });
});

test("limits respect finalized tool-batch termination instead of reviving or failing it", async (t) => {
  for (const terminalTurn of [1, 2]) {
    await t.test(`termination on turn ${terminalTurn} ends normally without an extra request`, async () => {
      await withRuntime(async ({ runtime, request, faux, fact }) => {
        faux.setResponses([
          ...(terminalTurn === 2 ? [readFact(fact)] : []),
          readFact(fact, "TERMINAL_RESULT"), answer("REVIVED_RESULT"),
        ]);
        const execution = await runtime.start(request);
        const result = await execution.completion;
        assert.equal(result.status, "completed");
        assert.equal(result.result, "TERMINAL_RESULT");
        assert.equal(faux.state.callCount, terminalTurn);
      }, (inner) => {
        const afterToolCall = inner.agent.afterToolCall;
        let calls = 0;
        inner.agent.afterToolCall = async (context, signal) => ({
          ...await afterToolCall?.(context, signal), terminate: ++calls === terminalTurn,
        });
      });
    });
  }

  await t.test("a policy block with termination also ends without a wrap-up request", async () => {
    await withRuntime(async ({ runtime, request, faux, fact }) => {
      faux.setResponses([readFact(fact, "POLICY_TERMINATED"), answer("REVIVED_RESULT")]);
      const execution = await runtime.start(request);
      const result = await execution.completion;
      assert.equal(result.status, "completed");
      assert.equal(result.result, "POLICY_TERMINATED");
      assert.equal(faux.state.callCount, 1);
    }, (inner) => {
      const beforeToolCall = inner.agent.beforeToolCall;
      inner.agent.beforeToolCall = async (context, signal) => ({
        ...await beforeToolCall?.(context, signal), block: true, reason: "Fixture policy", terminate: true,
      });
    });
  });

  await t.test("a mixed tool batch still receives its one wrap-up turn", async () => {
    await withRuntime(async ({ runtime, request, faux, fact }) => {
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("read", { path: fact }), fauxToolCall("read", { path: fact })], { stopReason: "toolUse" }),
        (context) => {
          assert.equal(hasLimitPrompt(context), true);
          return answer("MIXED_BATCH_FINISHED");
        },
      ]);
      const execution = await runtime.start(request);
      const result = await execution.completion;
      assert.equal(result.status, "completed");
      assert.equal(result.result, "MIXED_BATCH_FINISHED");
    }, (inner) => {
      const afterToolCall = inner.agent.afterToolCall;
      let calls = 0;
      inner.agent.afterToolCall = async (context, signal) => ({
        ...await afterToolCall?.(context, signal), terminate: ++calls === 1,
      });
    });
  });
});

test("unlimited runs, provider failures, and requested cancellation retain their own outcomes", { timeout: 30_000 }, async (t) => {
  await t.test("omitting the limit does not inject a budget instruction", async () => {
    await withRuntime(async ({ runtime, request, faux, fact }) => {
      faux.setResponses([readFact(fact), readFact(fact), (context) => {
        assert.equal(hasLimitPrompt(context), false);
        return answer("UNLIMITED_RESULT");
      }]);
      const execution = await runtime.start({ ...request, profile: "fixture-unlimited" });
      const result = await execution.completion;
      assert.equal(result.status, "completed");
      assert.equal(result.result, "UNLIMITED_RESULT");
    });
  });

  await t.test("a provider error is a failure on start and resume", async () => {
    await withRuntime(async ({ runtime, request, faux }) => {
      const failure = fauxAssistantMessage([], { stopReason: "error", errorMessage: "FIXTURE_error" });
      faux.setResponses([failure, failure]);
      const execution = await runtime.start(request);
      const result = await execution.completion;
      assert.equal(result.status, "failed");
      assert.equal(result.error, "FIXTURE_error");
      const resumed = await runtime.resume({ ...request, sessionId: result.sessionId });
      const again = await resumed.completion;
      assert.equal(again.status, "failed");
      assert.equal(again.error, "FIXTURE_error");
    });
  });

  await t.test("stopping the child from its own chat is aborted, not failed or completed", async () => {
    await withRuntime(async ({ runtime, request, faux, sessions }) => {
      let sessionId;
      // The child chat's Stop calls the session's own abort(); the controller never hears of it.
      const stopFromChildChat = () => {
        void sessions.get(sessionId).inner.abort();
        return answer("NOT_A_COMPLETED_TASK");
      };
      faux.setResponses([stopFromChildChat]);
      const execution = await runtime.start(request);
      sessionId = execution.run.sessionId;
      const result = await execution.completion;
      assert.equal(result.status, "aborted");
      assert.equal(result.error, undefined);
      faux.setResponses([stopFromChildChat]);
      const resumed = await runtime.resume({ ...request, sessionId });
      const again = await resumed.completion;
      assert.equal(again.status, "aborted");
      assert.equal(again.error, undefined);
    });
  });

  await t.test("an explicit cancellation is aborted and the child can subsequently resume", async () => {
    await withRuntime(async ({ controller, runtime, request, faux }) => {
      let entered, release;
      const started = new Promise((resolve) => { entered = resolve; });
      const pending = new Promise((resolve) => { release = resolve; });
      faux.setResponses([async () => {
        entered();
        await pending;
        return answer("NOT_A_COMPLETED_TASK");
      }]);
      const execution = await runtime.start(request);
      await started;
      const stopping = controller.abort(execution.run.sessionId);
      release();
      await stopping;
      const result = await execution.completion;
      assert.equal(result.status, "aborted");
      assert.equal(result.error, undefined);
      faux.setResponses([answer("AFTER_CANCELLATION")]);
      const resumed = await runtime.resume({ ...request, sessionId: result.sessionId });
      const again = await resumed.completion;
      assert.equal(again.status, "completed");
      assert.equal(again.result, "AFTER_CANCELLATION");
    });
  });
});

for (const resume of [false, true]) {
  for (const saturated of [false, true]) {
    test(`Stop during foreground ${resume ? "resume" : "start"} setup settles the child${saturated ? " with a full queue" : ""}`, async () => {
      await withRuntime(async ({ runtime, request, faux, fact }) => {
        let previous;
        if (resume) {
          faux.setResponses([answer("INITIAL_RESULT")]);
          previous = await (await runtime.start(request)).completion;
        }
        let blocker, execution, watchdog;
        let release = () => {};
        try {
          if (saturated) {
            await writeFile(join(dirname(fact), "agents", "settings.json"), JSON.stringify({ builtInEnabled: true, maxConcurrent: 1 }));
            let entered;
            const started = new Promise((resolve) => { entered = resolve; });
            const held = new Promise((resolve) => { release = resolve; });
            faux.setResponses([async () => {
              entered();
              await held;
              return answer("BLOCKER_RESULT");
            }]);
            blocker = await runtime.start({ ...request, runInBackground: true });
            await started;
          }
          let prompts = 0;
          faux.setResponses([() => { prompts++; return answer("MUST_NOT_RUN"); }]);
          const parentAbort = new AbortController();
          const tools = new Map();
          await createSubagentExtension({
            ...runtime,
            async start(value) { execution = await runtime.start(value); return execution; },
            async resume(value) { execution = await runtime.resume(value); return execution; },
          }, () => []).factory({ registerTool(tool) { tools.set(tool.name, tool); } });
          const result = await tools.get("Agent").execute("setup-stop-call", {
            subagent_type: "fixture", prompt: "Inspect", description: "Setup Stop fixture", run_in_background: false,
            ...(resume ? { resume: previous.sessionId } : {}),
          }, parentAbort.signal, () => {
            // Dispatch emits the initial queued update before registering its abort listener.
            parentAbort.abort();
          }, request.parentContext);
          const terminal = await Promise.race([
            execution.completion,
            new Promise((_, reject) => {
              watchdog = setTimeout(() => reject(new Error("Cancelled child did not settle while its queue was full")), 2000);
            }),
          ]);
          assert.equal(result.isError, true);
          assert.match(result.content[0].text, /Result wait aborted/);
          assert.equal(terminal.status, "aborted");
          assert.equal((await runtime.get(terminal.sessionId)).status, "aborted");
          assert.equal(prompts, 0);
          if (blocker) assert.equal((await runtime.get(blocker.run.sessionId)).status, "running");
        } finally {
          clearTimeout(watchdog);
          release();
          await blocker?.completion;
          await execution?.completion;
        }
      });
    });
  }

  test(`a timed-out foreground ${resume ? "resume" : "start"} stays live in the real SDK and reports completion`, async () => {
    await withRuntime(async ({ runtime, request, faux, sessions }) => {
      let previous;
      if (resume) {
        faux.setResponses([answer("INITIAL_RESULT")]);
        previous = await (await runtime.start(request)).completion;
      }
      let entered, release, notified;
      const started = new Promise((resolve) => { entered = resolve; });
      const held = new Promise((resolve) => { release = resolve; });
      const notification = new Promise((resolve) => { notified = resolve; });
      faux.setResponses([async () => {
        entered();
        await held;
        return answer("AFTER_WAIT_LIMIT");
      }]);
      const parent = sessions.get(request.parentContext.sessionManager.getSessionId());
      parent.inner.sendCustomMessage = async (message, options) => notified({ message, options });
      let execution;
      const tools = new Map();
      await createSubagentExtension({
        ...runtime,
        async start(value) { execution = await runtime.start(value); return execution; },
        async resume(value) { execution = await runtime.resume(value); return execution; },
      }, () => []).factory({ registerTool(tool) { tools.set(tool.name, tool); } });
      const parentAbort = new AbortController();
      // Use a short real budget around real wrappers: mocking timers across their lifetimes
      // strands real idle timers when cleanup runs under the fake clock. Unit tests pin 1800s.
      const result = tools.get("Agent").execute("wait-limit-call", {
        subagent_type: "fixture", prompt: "Inspect", description: "Wait fixture", run_in_background: false,
        wait_timeout: 1,
        ...(resume ? { resume: previous.sessionId } : {}),
      }, parentAbort.signal, undefined, request.parentContext);
      try {
        await started;
        const timedOut = await result;
        assert.equal(timedOut.details.status, "running");
        assert.ok(timedOut.content[0].text.includes("Wait budget exhausted (1 seconds)"));
        parentAbort.abort();
        assert.equal((await runtime.get(execution.run.sessionId)).status, "running");
        release();
        const completed = await execution.completion;
        assert.equal(completed.status, "completed", "A later parent Stop must not abort the child");
        assert.equal(completed.result, "AFTER_WAIT_LIMIT");
        const report = await notification;
        assert.equal(report.message.details.sessionId, completed.sessionId);
        assert.match(report.message.content, /AFTER_WAIT_LIMIT/);
        assert.deepEqual(report.options, { deliverAs: "followUp", triggerTurn: true });
        assert.equal((await runtime.get(completed.sessionId)).status, "completed");
        await sessions.get(completed.sessionId).shutdown();
        sessions.delete(completed.sessionId);
        assert.equal((await runtime.get(completed.sessionId)).result, "AFTER_WAIT_LIMIT");
      } finally {
        release();
        await execution?.completion;
      }
    });
  });
}

test("a run stopped before its prompt keeps a session file, so it outlives its wrapper", async () => {
  await withRuntime(async ({ controller, runtime, request, faux, fact, sessions }) => {
    await writeFile(join(dirname(fact), "agents", "settings.json"), JSON.stringify({ builtInEnabled: true, maxConcurrent: 1 }));
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    faux.setResponses([async () => {
      await held;
      return answer("FIRST");
    }]);
    const first = await runtime.start({ ...request, runInBackground: true });
    const queued = await runtime.start({ ...request, runInBackground: true });
    assert.equal(queued.run.status, "queued");
    await controller.abort(queued.run.sessionId);
    const stopped = await queued.completion;
    release();
    await first.completion;
    assert.equal(stopped.status, "aborted");
    // pi writes a session file only once it holds a user or assistant message; this run never sent one.
    assert.equal(existsSync(stopped.sessionPath), true);

    // The idle child's wrapper is released: only the file can answer now.
    await sessions.get(stopped.sessionId).shutdown();
    sessions.delete(stopped.sessionId);
    const found = await runtime.get(stopped.sessionId);
    assert.equal(found?.status, "aborted");
    assert.equal(found?.sessionPath, stopped.sessionPath);
  });
});

test("a deleted child stays deleted, so resume cannot reopen its missing file", async () => {
  await withRuntime(async ({ runtime, request, faux, sessions }) => {
    faux.setResponses([answer("DONE")]);
    const result = await (await runtime.start(request)).completion;
    assert.equal(result.status, "completed");
    await unlink(result.sessionPath);
    await sessions.get(result.sessionId).shutdown();
    sessions.delete(result.sessionId);
    // A run remembered past its file would make resume open the missing path as a new session.
    assert.equal(await runtime.get(result.sessionId), null);
    await assert.rejects(
      runtime.resume({ ...request, sessionId: result.sessionId }),
      /Subagent not found/,
    );
  });
});

test("the profile decides thinking and parent context, and input files still reach the task", async () => {
  await withRuntime(async ({ runtime, request, faux, fact, sessions }) => {
    let seen;
    faux.setResponses([(context) => {
      seen = JSON.stringify({ systemPrompt: context.systemPrompt, messages: context.messages });
      return answer("PROFILE_OPTIONS_RESULT");
    }]);
    const parentThinking = sessions.get(request.parentContext.sessionManager.getSessionId()).inner.thinkingLevel;
    assert.notEqual(parentThinking, "low", "The fixture needs a parent level the profile can differ from.");
    const execution = await runtime.start({
      ...request, profile: "fixture-profile-options", inputFiles: [basename(fact)],
    });
    const result = await execution.completion;
    assert.equal(result.status, "completed");
    assert.equal(result.result, "PROFILE_OPTIONS_RESULT");
    assert.equal(sessions.get(execution.run.sessionId).inner.thinkingLevel, "low");
    assert.match(seen, /active conversation context from the parent session/);
    assert.match(seen, /<document path=\\"fact\.txt\\">\\nThe fixture value is 42\./);
  });
});

test("input files beyond a tenth of the child model's window are refused before a worktree or session exists", async () => {
  await withRuntime(async ({ runtime, request, faux, sessions, dir }) => {
    const git = (...args) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
    try {
      git("init", "-q");
      git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "--allow-empty", "-m", "init");
      // 4,000 bytes: within the parent model's 128k window (51,200 bytes), past small-window's 8k (3,200).
      await writeFile(join(dir, "large.md"), "x".repeat(4_000));
      const runs = () => [...(globalThis.__piSubagentRuns?.values() ?? [])].length;
      const runsBefore = runs();

      await assert.rejects(
        runtime.start({ ...request, model: "faux/small-window", isolation: "worktree", inputFiles: ["large.md"] }),
        /exceeds the 3 KB total limit for faux\/small-window, about a tenth of its context window\. .*name the paths in prompt/,
      );
      assert.equal(sessions.size, 1, "no child session was registered");
      assert.equal(runs(), runsBefore, "no run was queued");
      assert.equal(existsSync(`${dir}-worktrees`), false, "no worktree was created");
      assert.equal(git("branch", "--list", "pi-web-agent-*"), "");
      // A profile's model sizes the copy when the call names none (models fill unused fields with "").
      await writeFile(join(dir, "agents", "fixture-small-window.md"), [
        "---", "description: Exercise a profile model with a small window.", "tools: read",
        "load_skills: false", "load_extensions: false", "model: faux/small-window",
        "---", "Complete the assigned task.",
      ].join("\n"));
      await assert.rejects(
        runtime.start({ ...request, profile: "fixture-small-window", model: "", inputFiles: ["large.md"] }),
        /exceeds the 3 KB total limit for faux\/small-window/,
      );
      assert.equal(sessions.size, 1, "no child session was registered");

      faux.setResponses([answer("WITHIN_THE_WINDOW")]);
      const execution = await runtime.start({ ...request, inputFiles: ["large.md"] });
      const result = await execution.completion;
      assert.equal(result.status, "completed");
      assert.equal(result.result, "WITHIN_THE_WINDOW");
    } finally {
      await rm(`${dir}-worktrees`, { recursive: true, force: true });
    }
  });
});

// The child's services refresh the shared runtime and register its extensions' providers before
// its model is resolved, so sizing input_files early must not refuse a model only they bring in.
test("a call model added to models.json after the parent started still runs", async () => {
  await withRuntime(async ({ runtime, request, faux, sessions, dir, modelRuntime }) => {
    await writeFile(join(dir, "models.json"), JSON.stringify({ providers: { faux: { models: [{ id: "late-model" }] } } }));
    assert.equal(modelRuntime.getModel("faux", "late-model"), undefined);

    faux.setResponses([answer("LATE_MODEL_RESULT")]);
    const execution = await runtime.start({ ...request, model: "faux/late-model", inputFiles: ["fact.txt"] });
    const result = await execution.completion;
    assert.equal(result.status, "completed");
    assert.equal(result.result, "LATE_MODEL_RESULT");
    assert.equal(sessions.get(result.sessionId).inner.model.id, "late-model");
  }, undefined, { modelsFile: true });
});

test("a profile model from a provider only the child's extensions register still runs", async () => {
  await withRuntime(async ({ runtime, request, faux, sessions, dir, modelRuntime }) => {
    // This fixture nests its agentDir inside cwd; approve that project ownership explicitly.
    new ProjectTrustStore(dir).set(dir, true);
    await mkdir(join(dir, "extensions"));
    await writeFile(join(dir, "extensions", "late-provider.ts"), `export default function (pi) {
  pi.registerProvider("late", { baseUrl: "http://127.0.0.1:9", apiKey: "dummy", api: "late-api",
    streamSimple: (...args) => globalThis.__subagentFixtureStream(...args),
    models: [{ id: "late-model", name: "Late", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 100 }] });
}
`);
    await writeFile(join(dir, "agents", "fixture-extension-model.md"), [
      "---", "description: Exercise a model an extension registers.", "tools: read",
      "load_skills: false", "load_extensions: true", "model: late/late-model",
      "---", "Complete the assigned task.",
    ].join("\n"));
    globalThis.__subagentFixtureStream = (...args) => faux.provider.streamSimple(...args);
    try {
      assert.equal(modelRuntime.getModel("late", "late-model"), undefined);

      faux.setResponses([answer("EXTENSION_MODEL_RESULT")]);
      const execution = await runtime.start({ ...request, profile: "fixture-extension-model", inputFiles: ["fact.txt"] });
      const result = await execution.completion;
      assert.equal(result.status, "completed");
      assert.equal(result.result, "EXTENSION_MODEL_RESULT");
      const { model } = sessions.get(result.sessionId).inner;
      assert.equal(`${model.provider}/${model.id}`, "late/late-model");
    } finally {
      delete globalThis.__subagentFixtureStream;
    }
  });
});

test("a model reference may carry pi's :level suffix, which sets the child's thinking", async (t) => {
  const run = async (runtime, faux, sessions, request) => {
    faux.setResponses([answer("MODEL_LEVEL_RESULT")]);
    const execution = await runtime.start(request);
    const result = await execution.completion;
    assert.equal(result.status, "completed");
    const child = sessions.get(execution.run.sessionId).inner;
    return { model: child.model.id, thinking: child.thinkingLevel };
  };

  // D3 priority: an explicit call level wins, then the profile's own `thinking`, then the chosen
  // model's `:level` suffix, then the parent. So the profile's `low` beats a call's `:high`.
  await t.test("the profile's thinking beats a call model's :level suffix; without either the profile decides", async () => {
    await withRuntime(async ({ runtime, request, faux, sessions }) => {
      const parentThinking = sessions.get(request.parentContext.sessionManager.getSessionId()).inner.thinkingLevel;
      assert.ok(!["low", "high"].includes(parentThinking), "The fixture needs a parent level both levels differ from.");
      const profileRequest = { ...request, profile: "fixture-profile-options" };
      assert.deepEqual(await run(runtime, faux, sessions, { ...profileRequest, model: "faux/faux-model:high" }), {
        model: "faux-model", thinking: "low",
      });
      assert.deepEqual(await run(runtime, faux, sessions, { ...profileRequest, model: "faux/faux-model" }), {
        model: "faux-model", thinking: "low",
      });
    });
  });

  await t.test("a profile model's level applies unless the profile sets thinking", async () => {
    await withRuntime(async ({ runtime, request, faux, sessions }) => {
      const parentThinking = sessions.get(request.parentContext.sessionManager.getSessionId()).inner.thinkingLevel;
      assert.ok(!["minimal", "high"].includes(parentThinking), "The fixture needs a parent level both levels differ from.");
      assert.deepEqual(await run(runtime, faux, sessions, { ...request, profile: "fixture-model-level" }), {
        model: "faux-model", thinking: "high",
      });
      assert.deepEqual(await run(runtime, faux, sessions, { ...request, profile: "fixture-model-level-thinking" }), {
        model: "faux-model", thinking: "minimal",
      });
    });
  });

  await t.test("an id that contains a colon matches whole, and an unknown suffix is refused", async () => {
    await withRuntime(async ({ runtime, request, faux, sessions }) => {
      assert.deepEqual(
        await run(runtime, faux, sessions, { ...request, profile: "fixture-profile-options", model: "faux/tuned:high" }),
        { model: "tuned:high", thinking: "low" },
      );
      await assert.rejects(
        runtime.start({ ...request, model: "faux/faux-model:turbo" }),
        /Subagent model not found: faux\/faux-model:turbo/,
      );
    });
  });
});

test("an isolated run's result says where its worktree went, live and read back from the file (#1202)", { timeout: 60_000 }, async (t) => {
  const removed = (run) => `Its worktree was removed; branch ${run.worktreeBranch} keeps any commits it made.`;
  const readBack = (run) => readSubagentRun(SessionManager.open(run.sessionPath).getEntries(), run.sessionId, run.sessionPath);

  await t.test("a clean checkout is removed and its branch named", async () => {
    await withRuntime(async ({ runtime, request, faux }) => {
      faux.setResponses([answer("CLEAN")]);
      const result = await (await runtime.start({ ...request, isolation: "worktree" })).completion;
      assert.equal(result.status, "completed");
      assert.equal(existsSync(result.worktreePath), false);
      const text = subagentFinalText(result);
      assert.equal(text, `Subagent ${result.sessionId} completed.\n\n${removed(result)}\n\nCLEAN`);
      assert.equal(subagentFinalText(readBack(result)), text);
    }, undefined, { repo: true });
  });

  await t.test("a checkout left with untracked files is kept, and the parent is told why", async () => {
    await withRuntime(async ({ runtime, request, faux }) => {
      let worktreePath;
      faux.setResponses([async () => {
        await writeFile(join(worktreePath, "notes.txt"), "draft\n");
        return answer("DIRTY");
      }]);
      const result = await (await runtime.start({
        ...request, isolation: "worktree", onUpdate: (run) => { worktreePath ??= run.worktreePath; },
      })).completion;
      assert.equal(existsSync(join(result.worktreePath, "notes.txt")), true);
      const text = subagentFinalText(result);
      assert.equal(text, `Subagent ${result.sessionId} completed.\n\nIts worktree was kept at ${result.worktreePath} (branch ${result.worktreeBranch}) because it still has uncommitted or untracked files.\n\nDIRTY`);
      assert.doesNotMatch(text, /--force|fatal:/);
      assert.equal(subagentFinalText(readBack(result)), text);
    }, undefined, { repo: true });
  });

  await t.test("a checkout removed during the run is reported removed, though git's removal then fails", async () => {
    await withRuntime(async ({ runtime, request, faux, dir }) => {
      let worktreePath;
      faux.setResponses([async () => {
        // As the sidebar's worktree picker removes it.
        await removeWorktree(dir, worktreePath);
        return answer("GONE");
      }]);
      const result = await (await runtime.start({
        ...request, isolation: "worktree", onUpdate: (run) => { worktreePath ??= run.worktreePath; },
      })).completion;
      assert.match(result.worktreeCleanupError, /Not a worktree of this repository/);
      const text = subagentFinalText(result);
      assert.equal(text, `Subagent ${result.sessionId} completed.\n\n${removed(result)}\n\nGONE`);
      assert.equal(subagentFinalText(readBack(result)), text);
    }, undefined, { repo: true });
  });

  await t.test("a run stopped before it began removes its checkout and says so", async () => {
    await withRuntime(async ({ runtime, request, faux }) => {
      const abort = new AbortController();
      let queuedUpdates = 0;
      const execution = await runtime.start({
        ...request, isolation: "worktree", signal: abort.signal,
        // The queue's own "queued" update comes after the parent's abort is wired up and before the
        // run can be cancelled in the queue, so the run itself finds the abort as it starts.
        onUpdate: (run) => { if (run.status === "queued" && ++queuedUpdates === 2) abort.abort(); },
      });
      const result = await execution.completion;
      assert.equal(result.status, "aborted");
      assert.equal(faux.state.callCount, 0);
      assert.equal(existsSync(result.worktreePath), false);
      const text = subagentFinalText(result);
      assert.equal(text, `Subagent ${result.sessionId} was stopped.\n\n${removed(result)}`);
      // The child's file is written at dispatch, so even a run that never prompted reads back the same.
      assert.equal(subagentFinalText(readBack(result)), text);
    }, undefined, { repo: true });
  });

  await t.test("a run without isolation says nothing about a worktree", async () => {
    await withRuntime(async ({ runtime, request, faux }) => {
      faux.setResponses([answer("PLAIN")]);
      const result = await (await runtime.start(request)).completion;
      assert.equal(subagentFinalText(result), `Subagent ${result.sessionId} completed.\n\nPLAIN`);
      assert.equal(readBack(result).worktreeExists, undefined);
    }, undefined, { repo: true });
  });
});

test("formal child creation refuses an unknown resource before registering or prompting, without harming a valid sibling", async () => {
  await withRuntime(async ({ runtime, request, faux, sessions, dir }) => {
    await writeFile(join(dir, "agents", "missing-resource.md"), "---\ndescription: Missing resource\ntools: read\nskills: false\nextensions: [missing-extension-selector]\n---\nFixture\n");
    await assert.rejects(runtime.start({ ...request, profile: "missing-resource" }), /Cannot load subagent resources: Unknown resource/);
    assert.equal(sessions.size, 1);
    assert.equal(faux.state.callCount, 0);
    faux.setResponses([answer("VALID_SIBLING")]);
    assert.equal((await (await runtime.start(request)).completion).result, "VALID_SIBLING");
  });
});

test("the formal Agent entry preserves an explicit max_turns zero over a role's positive limit", async () => {
  await withRuntime(async ({ runtime, request, faux, fact }) => {
    faux.setResponses([readFact(fact), readFact(fact), readFact(fact), (context) => {
      assert.equal(hasLimitPrompt(context), false);
      return answer("ZERO_OVERRIDES_ROLE_LIMIT");
    }]);
    const tools = new Map();
    await createSubagentExtension(runtime, () => []).factory({ registerTool(tool) { tools.set(tool.name, tool); } });
    const result = await tools.get("Agent").execute("explicit-zero", {
      subagent_type: "fixture", prompt: request.task, description: "Unlimited call override", max_turns: 0,
    }, undefined, undefined, request.parentContext);
    assert.equal(result.isError, undefined);
    assert.equal(result.details.status, "completed");
    assert.match(result.content[0].text, /ZERO_OVERRIDES_ROLE_LIMIT/);
    assert.equal(faux.state.callCount, 4, "the role's max_turns 1 was not silently substituted");
  });
});

for (const streamingBehavior of ["steer", "followUp"]) {
  test(`a live delegated child admits right-chat ${streamingBehavior} before completion, and Recall/Stop cannot restart it`, { timeout: 10_000 }, async () => {
    await withRuntime(async ({ controller, runtime, request, faux, sessions }) => {
      let entered, release;
      const started = new Promise((resolve) => { entered = resolve; });
      const held = new Promise((resolve) => { release = resolve; });
      faux.setResponses([async () => { entered(); await held; return answer("FIRST_RESPONSE"); }]);
      const execution = await runtime.start(request);
      try {
        await started;
        const child = sessions.get(execution.run.sessionId);
        await child.send({ type: "prompt", message: "QUEUED_FROM_RIGHT_CHAT", streamingBehavior });
        assert.ok((streamingBehavior === "steer" ? child.inner.getSteeringMessages() : child.inner.getFollowUpMessages()).includes("QUEUED_FROM_RIGHT_CHAT"));
        const recalled = await child.send({ type: "clear_queue" });
        assert.ok([...recalled.steering, ...recalled.followUp].includes("QUEUED_FROM_RIGHT_CHAT"));
        const stopped = controller.abort(execution.run.sessionId);
        release();
        await stopped;
        assert.equal((await execution.completion).status, "aborted");
        assert.equal(faux.state.callCount, 1, "no post-Stop provider request escapes the SDK queue cleanup");
      } finally { release(); await execution.completion; }
    });
  });
}

test("a right-chat follow-up admitted to a delegated run is drained at the role's turn limit", { timeout: 10_000 }, async () => {
  await withRuntime(async ({ runtime, request, faux, sessions, fact }) => {
    let entered, release;
    const started = new Promise((resolve) => { entered = resolve; });
    const held = new Promise((resolve) => { release = resolve; });
    faux.setResponses([async () => { entered(); await held; return readFact(fact); }, readFact(fact)]);
    const execution = await runtime.start(request);
    try {
      await started;
      const child = sessions.get(execution.run.sessionId);
      await child.send({ type: "prompt", message: "UNDISPATCHED_AFTER_LIMIT", streamingBehavior: "followUp" });
      assert.ok(child.inner.getFollowUpMessages().includes("UNDISPATCHED_AFTER_LIMIT"));
      release();
      const result = await execution.completion;
      assert.equal(result.status, "failed");
      assert.match(result.error, /turn limit.*1/);
      assert.match(result.error, /UNDISPATCHED_AFTER_LIMIT/);
      assert.equal(faux.state.callCount, 2, "only the initial and the single wrap-up request ran");
      assert.deepEqual(child.inner.getFollowUpMessages(), []);
    } finally { release(); await execution.completion; }
  });
});
