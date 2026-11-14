import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = await mkdtemp(join(tmpdir(), "pi-web-subagent-route-global-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, PUT, PATCH, DELETE } = await jiti.import("./route.ts");
const { allowFileRoot } = await jiti.import("../../../../lib/file-access.ts");
const { parseFrontmatter } = await jiti.import("../../../../lib/frontmatter.ts");

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(testAgentDir, { recursive: true, force: true });
});

function profile(overrides = {}) {
  return {
    name: "api-test-agent",
    displayName: "API test agent",
    description: "Used by route tests",
    systemPrompt: "Return a concise result.",
    tools: [],
    loadSkills: true,
    loadExtensions: true,
    inheritContext: false,
    runInBackground: true,
    enabled: true,
    ...overrides,
  };
}

function jsonRequest(method, body) {
  return new Request("http://localhost/api/subagents/profiles", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("profile PUT validates scoped MCP fields and old clients preserve stored role capabilities", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-child-profile-put-")); allowFileRoot(cwd);
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const capabilities = { codeMode: true, loadMcp: true, mcpServers: [{ scope: "global", name: "Case-ID" }] };
  let response = await PUT(jsonRequest("PUT", { cwd, scope: "project", profile: profile(capabilities) }));
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).profile.mcpServers, capabilities.mcpServers);
  response = await PUT(jsonRequest("PUT", { cwd, scope: "project", profile: profile({ description: "old client" }) }));
  assert.equal(response.status, 200); const preserved = (await response.json()).profile;
  assert.equal(preserved.codeMode, true); assert.equal(preserved.loadMcp, true); assert.deepEqual(preserved.mcpServers, capabilities.mcpServers);
  for (const invalid of [{ codeMode: "true" }, { loadMcp: null }, { mcpServers: ["Case-ID"] }, { mcpServers: [{ name: "Case-ID" }] }, { mcpServers: [{ scope: "global", name: "Case-ID", config: {} }] }]) {
    response = await PUT(jsonRequest("PUT", { cwd, scope: "project", profile: profile(invalid) })); assert.equal(response.status, 400);
  }
  response = await PUT(jsonRequest("PUT", { cwd, scope: "project", profile: profile({ codeMode: false, loadMcp: false, mcpServers: [] }) }));
  assert.equal(response.status, 200); const disabled = (await response.json()).profile;
  assert.equal(disabled.codeMode, false); assert.equal(disabled.loadMcp, false); assert.deepEqual(disabled.mcpServers, []);
});

test("model override permission defaults off, survives old PUT/clone/PATCH and rejects non-booleans", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-profile-model-permission-")); allowFileRoot(cwd);
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const put = (draft, extra = {}) => PUT(jsonRequest("PUT", { cwd, scope: "project", profile: draft, ...extra }));
  let response = await put(profile());
  assert.equal((await response.json()).profile.allowParentModelOverride, false);
  response = await put(profile({ allowParentModelOverride: true }));
  assert.equal((await response.json()).profile.allowParentModelOverride, true);
  const path = join(cwd, ".pi", "agents", "api-test-agent.md");
  await writeFile(path, (await readFile(path, "utf8")).replace("---\n", "---\nforeign_model_note: keep\n"));
  response = await put(profile({ description: "old client omits the field" }));
  assert.equal(response.status, 200); assert.equal((await response.json()).profile.allowParentModelOverride, true);
  response = await put(profile({ name: "model-copy" }), { cloneFrom: { scope: "project", name: "api-test-agent" } });
  assert.equal(response.status, 200); assert.equal((await response.json()).profile.allowParentModelOverride, true);
  response = await PATCH(jsonRequest("PATCH", { cwd, scope: "project", name: "api-test-agent", enabled: false }));
  assert.equal(response.status, 200); assert.equal((await response.json()).profile.allowParentModelOverride, true);
  for (const invalid of ["true", null, 1, {}]) {
    response = await put(profile({ allowParentModelOverride: invalid })); assert.equal(response.status, 400);
  }
  response = await put(profile({ allowParentModelOverride: false }));
  assert.equal(response.status, 200); assert.equal((await response.json()).profile.allowParentModelOverride, false);
  assert.match(await readFile(path, "utf8"), /foreign_model_note: keep/);
  assert.match(await readFile(path, "utf8"), /allow_parent_model_override: false/);
  const builtin = (await (await GET(new Request(`http://localhost/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`))).json()).profiles.find((item) => item.scope === "builtin");
  assert.equal(builtin.allowParentModelOverride, false);
});

test("profile PUT and PATCH keep local skill/extension selection and foreign fields", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "skill-route-"));
  allowFileRoot(cwd);
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
  const file = join(cwd, ".pi", "agents", "api-test-agent.md");
  await writeFile(file, `---\nskills: review, audit\nload_skills: false\nextensions: custom-extension\nforeign: retain-me\n---\nPrompt`);
  // `load_skills: false` closes skills even with an authored list; PATCH must not widen it.
  let response = await PATCH(jsonRequest("PATCH", { cwd, scope: "project", name: "api-test-agent", enabled: true }));
  assert.equal(response.status, 200);
  let saved = (await response.json()).profile;
  assert.equal(saved.loadSkills, false);
  assert.deepEqual(saved.extensions, ["custom-extension"]);
  // A save keeps the foreign key and the authored extensions list, and leaves the off switch.
  response = await PUT(jsonRequest("PUT", { cwd, scope: "project", profile: { ...saved, description: "Unrelated edit" } }));
  assert.equal(response.status, 200);
  saved = (await response.json()).profile;
  assert.equal(saved.loadSkills, false);
  assert.deepEqual(saved.extensions, ["custom-extension"]);
  const text = await readFile(file, "utf8");
  assert.match(text, /foreign: retain-me/);
  assert.match(text, /extensions: custom-extension/);
  assert.equal(parseFrontmatter(text).data.load_skills, false);
});

test("profile PUT rejects malformed skill selections instead of widening them", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "skill-route-invalid-"));
  allowFileRoot(cwd);
  t.after(() => rm(cwd, { recursive: true, force: true }));
  // The local contract is boolean | string[]; a non-array or non-string entry is refused.
  for (const skills of [[42], ["review", 42], "review"]) {
    const response = await PUT(jsonRequest("PUT", { cwd, scope: "project", profile: profile({ skills }) }));
    assert.equal(response.status, 400, JSON.stringify(skills));
  }
  // An explicit off switch round-trips and an old boolean-only client can reopen it, never All.
  let response = await PUT(jsonRequest("PUT", { cwd, scope: "project", profile: profile({ skills: false, loadSkills: false }) }));
  assert.equal(response.status, 200);
  const off = (await response.json()).profile;
  assert.equal(off.skills, false);
  assert.equal(off.loadSkills, false);
  response = await PUT(jsonRequest("PUT", { cwd, scope: "project", profile: profile({ description: "old client" }) }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).profile.loadSkills, true);
});

test("profile PUT persists each Code mode choice in global and project profiles", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "codemode-route-save-"));
  allowFileRoot(cwd);
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const name = "codemode-save-agent";
  t.after(() => rm(join(testAgentDir, "agents", `${name}.md`), { force: true }));

  for (const scope of ["global", "project"]) {
    const file = join(scope === "global" ? testAgentDir : join(cwd, ".pi"), "agents", `${name}.md`);
    for (const codeMode of [true, false]) {
      await t.test(`${scope}: ${codeMode}`, async () => {
        const response = await PUT(jsonRequest("PUT", { cwd, scope, profile: profile({ name, codeMode }) }));
        assert.equal(response.status, 200);
        const saved = (await response.json()).profile;
        assert.equal(saved.codeMode, codeMode);
        assert.equal(saved.scope, scope);
        assert.deepEqual(saved.tools, []);
        assert.equal(parseFrontmatter(await readFile(file, "utf8")).data.code_mode, codeMode);

        const listed = await GET(new Request(`http://localhost/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`));
        assert.equal(listed.status, 200);
        const source = (await listed.json()).profiles.find((item) => item.name === name && item.scope === scope);
        assert.equal(source.codeMode, codeMode);
        assert.deepEqual(source.tools, []);
      });
    }
  }
});

test("profile PUT keeps a stored Code mode when the field is omitted", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "codemode-route-default-"));
  allowFileRoot(cwd);
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const name = "codemode-default-agent";
  t.after(() => rm(join(testAgentDir, "agents", `${name}.md`), { force: true }));

  for (const scope of ["global", "project"]) {
    const file = join(scope === "global" ? testAgentDir : join(cwd, ".pi"), "agents", `${name}.md`);
    // Older API clients omit the field, including when updating an existing explicit choice.
    for (const existing of [false, true]) {
      if (existing) {
        const response = await PUT(jsonRequest("PUT", { cwd, scope, profile: profile({ name, codeMode: true }) }));
        assert.equal(response.status, 200);
      }
      const response = await PUT(jsonRequest("PUT", { cwd, scope, profile: profile({ name }) }));
      assert.equal(response.status, 200);
      // Our contract: an old PUT omitting the field retains what the file already has.
      assert.equal((await response.json()).profile.codeMode, existing);
      assert.equal(parseFrontmatter(await readFile(file, "utf8")).data.code_mode, existing);
    }
  }
});

test("profile PATCH retains codemode when toggling global and project profiles", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "codemode-route-toggle-"));
  allowFileRoot(cwd);
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const name = "codemode-toggle-agent";
  t.after(() => rm(join(testAgentDir, "agents", `${name}.md`), { force: true }));

  for (const scope of ["global", "project"]) {
    const dir = join(scope === "global" ? testAgentDir : join(cwd, ".pi"), "agents");
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${name}.md`);
    for (const [authored, expected] of [[true, true], [false, false], [undefined, false]]) {
      await t.test(`${scope}: authored ${String(authored)}`, async () => {
        const codeModeLine = authored === undefined ? "" : `code_mode: ${authored}\n`;
        await writeFile(file, `---\n${codeModeLine}tools: read, ext:codegraph/search\nextensions: all\nisolation: worktree\ncolor: teal\npersist_session: true\nforeign: retain-me\n---\nOriginal prompt`);
        for (const enabled of [false, true]) {
          const response = await PATCH(jsonRequest("PATCH", { cwd, scope, name, enabled }));
          assert.equal(response.status, 200);
          const saved = (await response.json()).profile;
          assert.equal(saved.codeMode, expected);
          assert.equal(saved.enabled, enabled);
          const { data, rest } = parseFrontmatter(await readFile(file, "utf8"));
          assert.equal(data.code_mode, expected);
          assert.equal(data.enabled, enabled);
          assert.equal(data.foreign, "retain-me");
          assert.equal(data.isolation, "worktree");
          assert.equal(data.color, "teal");
          assert.equal(data.persist_session, true);
          assert.ok(String(data.tools).includes("ext:codegraph/search"));
          assert.equal(data.extensions, true);
          assert.equal(rest.trim(), "Original prompt");

          const listed = await GET(new Request(`http://localhost/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`));
          assert.equal(listed.status, 200);
          const source = (await listed.json()).profiles.find((item) => item.name === name && item.scope === scope);
          assert.equal(source.codeMode, expected);
          assert.equal(source.enabled, enabled);
        }
      });
    }
  }
});

test("profile PUT rejects invalid Code mode without creating or overwriting files", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "codemode-route-invalid-"));
  allowFileRoot(cwd);
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const name = "codemode-invalid-agent";
  t.after(() => rm(join(testAgentDir, "agents", `${name}.md`), { force: true }));
  const invalidValues = [null, 0, 1, "", "auto", "ON", "OFF", "INHERIT", " on ", [], ["on"], {}];

  for (const scope of ["global", "project"]) {
    const file = join(scope === "global" ? testAgentDir : join(cwd, ".pi"), "agents", `${name}.md`);
    for (const existing of [false, true]) {
      let original;
      if (existing) {
        const response = await PUT(jsonRequest("PUT", { cwd, scope, profile: profile({ name, codeMode: false }) }));
        assert.equal(response.status, 200);
        original = await readFile(file, "utf8");
      }
      for (const codeMode of invalidValues) {
        const response = await PUT(jsonRequest("PUT", { cwd, scope, profile: profile({ name, codeMode }) }));
        assert.equal(response.status, 400, `${scope}: ${JSON.stringify(codeMode)}`);
        assert.deepEqual(await response.json(), { error: "codeMode must be boolean" });
        if (existing) assert.equal(await readFile(file, "utf8"), original);
        else assert.equal(existsSync(file), false);
      }
    }
  }
});

test("profiles route creates, lists, and deletes a project profile", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagent-route-"));
  allowFileRoot(cwd);
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const putResponse = await PUT(jsonRequest("PUT", { cwd, scope: "project", profile: profile() }));
  const putBody = await putResponse.json();
  assert.equal(putResponse.status, 200);
  assert.equal(putBody.profile.scope, "project");
  assert.deepEqual(putBody.profile.tools, []);
  assert.equal(putBody.profile.loadSkills, true);
  assert.equal(putBody.profile.loadExtensions, true);
  const source = await readFile(join(cwd, ".pi", "agents", "api-test-agent.md"), "utf8");
  assert.match(source, /tools: none/);
  assert.match(source, /load_skills: true/);
  assert.match(source, /load_extensions: true/);

  const getResponse = await GET(new Request(`http://localhost/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`));
  const getBody = await getResponse.json();
  assert.equal(getResponse.status, 200);
  const listedProfile = getBody.profiles.find((item) => item.name === "api-test-agent");
  assert.deepEqual(listedProfile.tools, []);
  assert.equal(listedProfile.loadSkills, true);
  assert.equal(listedProfile.loadExtensions, true);

  const deleteResponse = await DELETE(jsonRequest("DELETE", { cwd, scope: "project", name: "api-test-agent" }));
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(await deleteResponse.json(), { ok: true });

  const afterDelete = await GET(new Request(`http://localhost/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`));
  const afterDeleteBody = await afterDelete.json();
  assert.equal(afterDeleteBody.profiles.some((item) => item.name === "api-test-agent"), false);
});

test("profiles route keeps same-name global and project profiles independently editable", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagent-route-"));
  allowFileRoot(cwd);
  t.after(() => rm(cwd, { recursive: true, force: true }));

  let response = await PUT(jsonRequest("PUT", {
    cwd,
    scope: "global",
    profile: profile({ description: "Global profile" }),
  }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).profile.scope, "global");
  assert.match(await readFile(join(testAgentDir, "agents", "api-test-agent.md"), "utf8"), /Global profile/);

  response = await PUT(jsonRequest("PUT", {
    cwd,
    scope: "project",
    profile: profile({ description: "Project profile" }),
  }));
  assert.equal(response.status, 200);

  response = await GET(new Request(`http://localhost/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`));
  const sources = (await response.json()).profiles
    .filter((item) => item.name === "api-test-agent")
    .sort((a, b) => a.scope.localeCompare(b.scope));
  assert.deepEqual(sources.map((item) => item.scope), ["global", "project"]);
  assert.deepEqual(sources.map((item) => item.description), ["Global profile", "Project profile"]);

  response = await PATCH(jsonRequest("PATCH", {
    cwd,
    scope: "global",
    name: "api-test-agent",
    enabled: false,
  }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).profile.enabled, false);
  response = await GET(new Request(`http://localhost/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`));
  const toggledSources = (await response.json()).profiles.filter((item) => item.name === "api-test-agent");
  assert.equal(toggledSources.find((item) => item.scope === "global").enabled, false);
  assert.equal(toggledSources.find((item) => item.scope === "global").description, "Global profile");
  assert.equal(toggledSources.find((item) => item.scope === "global").loadSkills, true);
  assert.equal(toggledSources.find((item) => item.scope === "global").loadExtensions, true);
  assert.equal(toggledSources.find((item) => item.scope === "project").enabled, true);

  response = await DELETE(jsonRequest("DELETE", { cwd, scope: "project", name: "api-test-agent" }));
  assert.equal(response.status, 200);
  response = await GET(new Request(`http://localhost/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`));
  assert.deepEqual(
    (await response.json()).profiles.filter((item) => item.name === "api-test-agent").map((item) => item.scope),
    ["global"],
  );

  response = await DELETE(jsonRequest("DELETE", { cwd, scope: "global", name: "api-test-agent" }));
  assert.equal(response.status, 200);
});

test("profiles route toggles a built-in through settings.json without writing a profile file", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagent-route-"));
  allowFileRoot(cwd);
  t.after(async () => {
    await PATCH(jsonRequest("PATCH", { cwd, scope: "builtin", name: "explore", enabled: true }));
    await rm(cwd, { recursive: true, force: true });
  });

  let response = await PATCH(jsonRequest("PATCH", { cwd, scope: "builtin", name: "Explore", enabled: false }));
  assert.equal(response.status, 200);
  let body = await response.json();
  assert.equal(body.profile.scope, "builtin");
  assert.equal(body.profile.enabled, false);
  assert.equal(body.profile.filePath, undefined);
  assert.deepEqual(
    JSON.parse(await readFile(join(testAgentDir, "agents", "settings.json"), "utf8")).disabledBuiltIns,
    ["explore"],
  );
  assert.equal(existsSync(join(testAgentDir, "agents", "explore.md")), false);

  response = await GET(new Request(`http://localhost/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`));
  const builtIns = (await response.json()).profiles.filter((item) => item.scope === "builtin");
  assert.equal(builtIns.find((item) => item.name === "explore").enabled, false);
  assert.equal(builtIns.filter((item) => item.enabled).length, builtIns.length - 1);

  response = await PATCH(jsonRequest("PATCH", { cwd, scope: "builtin", name: "explore", enabled: true }));
  assert.equal(response.status, 200);
  body = await response.json();
  assert.equal(body.profile.enabled, true);
  assert.deepEqual(
    JSON.parse(await readFile(join(testAgentDir, "agents", "settings.json"), "utf8")).disabledBuiltIns,
    [],
  );

  response = await PATCH(jsonRequest("PATCH", { cwd, scope: "builtin", name: "not-a-built-in", enabled: false }));
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Agent profile not found" });
});

test("profiles route rejects missing paths, malformed profiles, and unsafe names", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagent-route-"));
  allowFileRoot(cwd);
  t.after(() => rm(cwd, { recursive: true, force: true }));

  let response = await GET(new Request("http://localhost/api/subagents/profiles"));
  assert.equal(response.status, 400);

  response = await PUT(jsonRequest("PUT", { cwd, scope: "project" }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "profile required" });

  response = await PUT(jsonRequest("PUT", { cwd, scope: "project", profile: profile({ name: "../escape" }) }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Agent name may contain only/);

  response = await PUT(jsonRequest("PUT", { cwd, scope: "project", profile: profile({ thinking: "extreme" }) }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Invalid thinking level/);

  response = await DELETE(jsonRequest("DELETE", { cwd, scope: "project" }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "name required" });

  response = await PUT(jsonRequest("PUT", { cwd, scope: "workspace", profile: profile() }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "scope must be global or project" });

  response = await PUT(jsonRequest("PUT", { cwd, scope: "builtin", profile: profile() }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "scope must be global or project" });

  response = await PATCH(jsonRequest("PATCH", { cwd, scope: "workspace", name: "explore", enabled: false }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "scope must be global, project, or builtin" });

  response = await DELETE(jsonRequest("DELETE", { cwd, scope: "builtin", name: "Explore" }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "scope must be global or project" });

  response = await PATCH(jsonRequest("PATCH", { cwd, scope: "project", name: "missing", enabled: false }));
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Agent profile not found" });

  response = await PATCH(jsonRequest("PATCH", { cwd, scope: "project", name: "api-test-agent" }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "enabled required" });
});
