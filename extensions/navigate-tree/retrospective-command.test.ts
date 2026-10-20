import * as assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { registerRetrospectiveCommand } from "./retrospective-command.ts";
import { inspectRetrospectiveSession } from "./retrospective-plan.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

const timestamp = "2026-01-01T00:00:00.000Z";
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "tree-clone-command-"));
  directories.push(directory);
  const sourcePath = join(directory, "source session.jsonl");
  const planPath = join(directory, "plan with spaces.json");
  const source = [
    {
      type: "session",
      version: 3,
      id: "original",
      cwd: directory,
      timestamp,
    },
    {
      type: "session_info",
      id: "name",
      parentId: null,
      timestamp,
      name: "Original",
    },
    {
      type: "message",
      id: "one",
      parentId: "name",
      timestamp,
      message: { role: "user", content: "Question", timestamp: 1 },
    },
  ];
  await writeFile(
    sourcePath,
    `${source.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  const inspected = await inspectRetrospectiveSession(sourcePath);
  await writeFile(
    planPath,
    JSON.stringify({
      version: 1,
      source: "source session.jsonl",
      sourceSha256: inspected.sourceSha256,
      nameSuffix: " (clone)",
      groups: [
        {
          name: "phase",
          firstEntryId: "one",
          lastEntryId: "one",
          summary: "The phase is complete.",
          children: [],
        },
      ],
    }),
  );
  return { directory, sourcePath, planPath };
}

type RegisteredCommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
interface CapturedCommand {
  name: string;
  options: RegisteredCommandOptions;
}

interface SideEffects {
  appends: number;
  messages: number;
  userMessages: number;
  sessionChanges: number;
  waits: number;
}

interface TestContextOptions {
  cwd: string;
  hasUI?: boolean;
  idle?: boolean;
  sessionFile?: string;
  inputResult?: string;
  editorResult?: string;
  confirmResult?: boolean;
}

function setup(options: TestContextOptions) {
  const sideEffects: SideEffects = {
    appends: 0,
    messages: 0,
    userMessages: 0,
    sessionChanges: 0,
    waits: 0,
  };
  const commands: CapturedCommand[] = [];
  const pi = {
    registerCommand(name: string, commandOptions: RegisteredCommandOptions) {
      commands.push({ name, options: commandOptions });
    },
    appendEntry() {
      sideEffects.appends++;
    },
    sendMessage() {
      sideEffects.messages++;
    },
    sendUserMessage() {
      sideEffects.userMessages++;
    },
  } as unknown as ExtensionAPI;
  registerRetrospectiveCommand(pi);
  const captured = commands.find((command) => command.name === "tree-clone");
  assert.ok(captured);

  const notifications: { message: string; type?: string }[] = [];
  const editors: { title: string; text: string }[] = [];
  const confirmations: { title: string; message: string }[] = [];
  const inputs: { title: string; placeholder?: string }[] = [];
  const ctx = {
    cwd: options.cwd,
    hasUI: options.hasUI ?? true,
    isIdle: () => options.idle ?? true,
    sessionManager: { getSessionFile: () => options.sessionFile },
    ui: {
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
      async editor(title: string, text: string) {
        editors.push({ title, text });
        return options.editorResult;
      },
      async confirm(title: string, message: string) {
        confirmations.push({ title, message });
        return options.confirmResult ?? false;
      },
      async input(title: string, placeholder?: string) {
        inputs.push({ title, placeholder });
        return options.inputResult;
      },
    },
    async switchSession() {
      sideEffects.sessionChanges++;
    },
    async newSession() {
      sideEffects.sessionChanges++;
    },
    async fork() {
      sideEffects.sessionChanges++;
    },
    async navigateTree() {
      sideEffects.sessionChanges++;
    },
    async waitForIdle() {
      sideEffects.waits++;
    },
  } as unknown as ExtensionCommandContext;

  return {
    command: captured.options,
    ctx,
    notifications,
    editors,
    confirmations,
    inputs,
    sideEffects,
  };
}

describe("retrospective clone command", () => {
  it("registers finite subcommand completions and keeps inspect/preview read-only", async () => {
    const files = await fixture();
    const before = await readFile(files.sourcePath);
    const command = setup({
      cwd: files.directory,
      sessionFile: files.sourcePath,
    });

    assert.match(command.command.description ?? "", /inspect <session\.jsonl>/);
    assert.deepEqual(await command.command.getArgumentCompletions?.("pre"), [
      {
        value: "preview ",
        label: "preview",
        description: "<plan.json> — review a clone plan",
      },
    ]);
    assert.equal(
      await command.command.getArgumentCompletions?.("preview "),
      null,
    );

    await command.command.handler("inspect", command.ctx);
    await command.command.handler(
      'preview "plan with spaces.json"',
      command.ctx,
    );

    assert.equal(command.editors.length, 2);
    assert.match(command.editors[0].title, /read-only/);
    assert.match(command.editors[0].text, /source session\.jsonl/);
    assert.match(command.editors[1].text, /The phase is complete\./);
    assert.ok(
      command.notifications.some(({ message }) =>
        message.includes("1 user turns"),
      ),
    );
    assert.deepEqual(await readFile(files.sourcePath), before);
    assert.deepEqual((await readdir(files.directory)).sort(), [
      "plan with spaces.json",
      "source session.jsonl",
    ]);
    assert.deepEqual(command.sideEffects, {
      appends: 0,
      messages: 0,
      userMessages: 0,
      sessionChanges: 0,
      waits: 0,
    });
  });

  it("prompts for a missing preview path when UI is available", async () => {
    const files = await fixture();
    const command = setup({
      cwd: files.directory,
      inputResult: '"plan with spaces.json"',
    });

    await command.command.handler("preview", command.ctx);

    assert.equal(command.inputs.length, 1);
    assert.match(command.inputs[0].title, /preview/);
    assert.equal(command.editors.length, 1);
    assert.match(command.notifications.at(-1)?.message ?? "", /Preview for/);
    assert.deepEqual((await readdir(files.directory)).sort(), [
      "plan with spaces.json",
      "source session.jsonl",
    ]);
  });

  it("does not write a clone when confirmation is cancelled", async () => {
    const files = await fixture();
    const before = await readFile(files.sourcePath);
    const command = setup({
      cwd: files.directory,
      confirmResult: false,
      editorResult: "edited preview must be ignored",
    });

    await command.command.handler(
      'create "plan with spaces.json"',
      command.ctx,
    );

    assert.equal(command.editors.length, 1);
    assert.match(command.editors[0].text, /previewToken/);
    assert.equal(command.confirmations.length, 1);
    assert.match(command.confirmations[0].title, /Original \(clone\)/);
    assert.match(
      command.confirmations[0].message,
      /original session will remain untouched/,
    );
    assert.match(
      command.notifications.at(-1)?.message ?? "",
      /cancelled; no files were written/,
    );
    assert.deepEqual(await readFile(files.sourcePath), before);
    assert.deepEqual((await readdir(files.directory)).sort(), [
      "plan with spaces.json",
      "source session.jsonl",
    ]);
    assert.deepEqual(command.sideEffects, {
      appends: 0,
      messages: 0,
      userMessages: 0,
      sessionChanges: 0,
      waits: 0,
    });
  });

  it("creates from the fresh preview without changing the source or active session", async () => {
    const files = await fixture();
    const before = await readFile(files.sourcePath);
    const command = setup({
      cwd: files.directory,
      confirmResult: true,
      editorResult: "edited preview must be ignored",
    });

    await command.command.handler(
      'create "plan with spaces.json"',
      command.ctx,
    );

    const entries = (await readdir(files.directory)).sort();
    assert.equal(entries.length, 3);
    assert.ok(entries.includes("source session.jsonl"));
    const cloneFile = entries.find(
      (entry) => entry.endsWith(".jsonl") && entry !== "source session.jsonl",
    );
    assert.ok(cloneFile);
    const clone = SessionManager.open(join(files.directory, cloneFile));
    assert.equal(clone.getSessionName(), "Original (clone)");
    assert.deepEqual(await readFile(files.sourcePath), before);
    assert.match(command.notifications.at(-1)?.message ?? "", /left untouched/);
    assert.deepEqual(command.sideEffects, {
      appends: 0,
      messages: 0,
      userMessages: 0,
      sessionChanges: 0,
      waits: 0,
    });
  });

  it("refuses headless or busy create requests without creating a session", async () => {
    const files = await fixture();
    const headless = setup({ cwd: files.directory, hasUI: false });
    await headless.command.handler("create plan.json", headless.ctx);
    assert.match(
      headless.notifications.at(-1)?.message ?? "",
      /scripts\/restructure-session\.mjs/,
    );
    assert.deepEqual((await readdir(files.directory)).sort(), [
      "plan with spaces.json",
      "source session.jsonl",
    ]);

    const busy = setup({ cwd: files.directory, idle: false });
    await busy.command.handler('create "plan with spaces.json"', busy.ctx);
    assert.match(busy.notifications.at(-1)?.message ?? "", /session is idle/);
    assert.equal(busy.editors.length, 0);
    assert.equal(busy.confirmations.length, 0);
    assert.deepEqual((await readdir(files.directory)).sort(), [
      "plan with spaces.json",
      "source session.jsonl",
    ]);
    assert.equal(busy.sideEffects.waits, 0);
    assert.equal(busy.sideEffects.sessionChanges, 0);
  });
});
