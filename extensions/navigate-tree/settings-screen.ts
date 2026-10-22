/**
 * `/anchor settings`: staged editor for `tree-navigator.json`.
 *
 * Edits are staged in memory against one target layer (global or project) and
 * written only on save, after a confirmation. Effective values come from the
 * real loader (`loadTreeNavigatorConfig`) and every candidate value is checked
 * with the real parsers (`parseTreeNavigatorConfig`), so the screen cannot
 * accept a value that the next session start would reject. A file that does
 * not parse as a JSON object is never written.
 */
import {
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  mkdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import {
  CONFIG_DIR_NAME,
  type ExtensionCommandContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
  AUTO_NAVIGATE_MAX_TOKENS,
  AUTO_NAVIGATE_MAX_TURNS,
  AUTO_NAVIGATE_MIN_TOKENS,
  AUTO_NAVIGATE_MIN_TURNS,
  type AutoNavigatePartial,
} from "./auto-navigate-config.ts";
import {
  loadTreeNavigatorConfig,
  type ParsedLayer,
  parseTreeNavigatorConfig,
  REWIND_HINT_MAX_RESERVE,
  REWIND_HINT_MIN_RESERVE,
  resolveAutoNavigateConfig,
  START_ANCHOR_MAX_TURNS,
  START_ANCHOR_MIN_TURNS,
  TREE_NAVIGATOR_CONFIG_FILENAME,
} from "./config.ts";
import { type FrameRow, type FrameScreen, selectFrame } from "./frame.ts";

/** Where the two config files live for the session and whether the project layer counts. */
export interface SettingsScreenDeps {
  locations(ctx: ExtensionCommandContext): {
    agentDir: string;
    projectPath: string;
    projectTrusted: boolean;
  };
  /** Defaults to UTF-8 `fs.readFile`. */
  readFile?(path: string): Promise<string>;
  /** Defaults to an atomic write (temp file + rename) that creates missing directories. */
  writeFile?(path: string, text: string): Promise<void>;
}

/** The deps for the live extension: pi's agent dir and the session's cwd and trust. */
export function createSettingsScreenDeps(): SettingsScreenDeps {
  return {
    locations: (ctx) => ({
      agentDir: getAgentDir(),
      projectPath: join(
        ctx.cwd,
        CONFIG_DIR_NAME,
        TREE_NAVIGATOR_CONFIG_FILENAME,
      ),
      projectTrusted: ctx.isProjectTrusted(),
    }),
  };
}

/** "done" ends the whole command; "back" returns to the screen that opened this one. */
type ScreenExit = "back" | "done";

const LAYERS = ["global", "project"] as const;
type Layer = (typeof LAYERS)[number];
type Source = Layer | "default";
type Root = Record<string, unknown>;
type Style = "camel" | "snake";
type Loaded = Awaited<ReturnType<typeof loadTreeNavigatorConfig>>["config"];

/** One key as the file may spell it. Snake_case wins when both exist, as in config.ts. */
interface KeyName {
  camel: string;
  snake: string;
  /** Spelling for a new key regardless of the file's style. */
  fresh?: Style;
  /** `auto_navigate: true` means `{ enabled: true }`; this is the key it stands for. */
  shorthand?: string;
}

const name = (camel: string, snake = camel): KeyName => ({ camel, snake });
const CONTINUITY = name("continuity");
const TREE_PROPOSAL = name("treeProposal", "tree_proposal");
const AUTO_NAVIGATE: KeyName = {
  camel: "autoNavigate",
  snake: "auto_navigate",
  fresh: "snake",
  shorthand: "enabled",
};

type Status =
  | { kind: "absent" }
  | { kind: "set" }
  | { kind: "invalid"; error?: string };
const ABSENT: Status = { kind: "absent" };
const SET: Status = { kind: "set" };

type Kind = "tokens" | "count" | "flag" | "choice" | "model" | "classifier";

interface SettingDef {
  /** Label and identity: the key as the README spells it. */
  key: string;
  path: readonly KeyName[];
  kind: Kind;
  choices?: readonly string[];
  /** Accepts the disable sentinels; written as `null`. */
  off?: boolean;
  /** What a valid value looks like, for the prompt and the refusal. */
  expects: string;
  description: string;
  /**
   * How an invalid value in a layer counts: it still claims the setting (hint),
   * falls through to the other layer (most fields), or blocks the whole group.
   */
  onInvalid: "claims" | "falls-through" | "blocks";
  status(layer: ParsedLayer): Status;
  read(config: Loaded): unknown;
}

const count = (n: number): string => n.toLocaleString("en-US");
const range = (min: number, max: number): string =>
  `${count(min)}-${count(max)}`;

/** `50k`, `1.5M`, or the plain number when it has no short form. */
function tokens(n: number): string {
  if (n >= 1_000_000 && n % 100_000 === 0) return `${n / 1_000_000}M`;
  if (n >= 1_000 && n % 100 === 0) return `${n / 1_000}k`;
  return count(n);
}

const fieldStatus = (field: {
  kind: "absent" | "ok" | "disabled" | "invalid";
}): Status =>
  field.kind === "absent"
    ? ABSENT
    : field.kind === "invalid"
      ? { kind: "invalid" }
      : SET;

const continuityStatus =
  (pick: "capture" | "intentClassifier") =>
  (layer: ParsedLayer): Status =>
    layer.continuity ? fieldStatus(layer.continuity[pick]) : ABSENT;

const autoStatus =
  (field: keyof AutoNavigatePartial) =>
  (layer: ParsedLayer): Status => {
    const block = layer.autoNavigate;
    if (!block) return ABSENT;
    if (block.kind === "invalid")
      return { kind: "invalid", error: block.error };
    return block.value[field] === undefined ? ABSENT : SET;
  };

const autoRead = (config: Loaded) =>
  resolveAutoNavigateConfig(config, undefined);

const TOKEN_RANGE = range(AUTO_NAVIGATE_MIN_TOKENS, AUTO_NAVIGATE_MAX_TOKENS);

const SETTINGS: readonly SettingDef[] = [
  {
    key: "rewindHintReserveTokens",
    path: [name("rewindHintReserveTokens", "rewind_hint_reserve_tokens")],
    kind: "tokens",
    off: true,
    onInvalid: "claims",
    expects: `${range(REWIND_HINT_MIN_RESERVE, REWIND_HINT_MAX_RESERVE)} tokens (e.g. 50k), or off`,
    description: `Nudge the agent to rewind when this many tokens are left in the window. ${range(REWIND_HINT_MIN_RESERVE, REWIND_HINT_MAX_RESERVE)}, or off (default).`,
    status: (layer) => fieldStatus(layer.hint),
    read: (config) => config.rewindHintReserveTokens,
  },
  {
    key: "anchorStartAfterTurns",
    path: [name("anchorStartAfterTurns", "anchor_start_after_turns")],
    kind: "count",
    onInvalid: "falls-through",
    expects: `${range(START_ANCHOR_MIN_TURNS, START_ANCHOR_MAX_TURNS)} turns`,
    description: `Turn of an agent run at which the silent start anchor is written. ${range(START_ANCHOR_MIN_TURNS, START_ANCHOR_MAX_TURNS)} (default 2).`,
    status: (layer) => fieldStatus(layer.startAnchor),
    read: (config) => config.anchorStartAfterTurns,
  },
  {
    key: "parentHandoffMode",
    path: [name("parentHandoffMode", "parent_handoff_mode")],
    kind: "choice",
    choices: ["full", "synthesized"],
    onInvalid: "falls-through",
    expects: "full or synthesized",
    description:
      "Child reports in the parent's context: full keeps each one (default), synthesized writes one focused report.",
    status: (layer) => fieldStatus(layer.parentHandoffMode),
    read: (config) => config.parentHandoffMode,
  },
  {
    key: "continuity.capture",
    path: [CONTINUITY, name("capture")],
    kind: "flag",
    onInvalid: "falls-through",
    expects: "true or false",
    description:
      "Capture your rules and decisions from messages into the continuity ledger. Default true.",
    status: continuityStatus("capture"),
    read: (config) => config.continuity.capture,
  },
  {
    key: "continuity.intentClassifier",
    path: [CONTINUITY, name("intentClassifier", "intent_classifier")],
    kind: "classifier",
    off: true,
    onInvalid: "falls-through",
    expects: "provider/id of a model, or off",
    description:
      "Model (provider/id) that judges each new message for the ledger. off (default) uses heuristics only.",
    status: continuityStatus("intentClassifier"),
    read: (config) => config.continuity.intentClassifier,
  },
  {
    key: "treeProposal.model",
    path: [TREE_PROPOSAL, name("model")],
    kind: "model",
    onInvalid: "blocks",
    expects: "current or provider/id[:thinking]",
    description:
      "Model for tree proposals: current (the active model) or provider/id[:thinking]. Default current.",
    status: (layer) =>
      layer.proposal === undefined
        ? ABSENT
        : layer.proposal.kind === "invalid"
          ? { kind: "invalid", error: layer.proposal.error }
          : layer.proposal.value.model === undefined
            ? ABSENT
            : SET,
    read: (config) =>
      config.proposalError === undefined
        ? (config.proposal?.model ?? "current")
        : undefined,
  },
  {
    key: "auto_navigate.enabled",
    path: [AUTO_NAVIGATE, name("enabled")],
    kind: "flag",
    onInvalid: "blocks",
    expects: "true or false",
    description:
      "Let a sidecar controller set anchors and fold on its own as the context grows. Default false.",
    status: autoStatus("enabled"),
    read: (config) => autoRead(config).enabled,
  },
  {
    key: "auto_navigate.mode",
    path: [AUTO_NAVIGATE, name("mode")],
    kind: "choice",
    choices: ["anchor-only", "anchor-and-rewind"],
    onInvalid: "blocks",
    expects: "anchor-only or anchor-and-rewind",
    description:
      "anchor-only sets anchors; anchor-and-rewind (default) may also fold back to one.",
    status: autoStatus("mode"),
    read: (config) => autoRead(config).mode,
  },
  {
    key: "auto_navigate.controller_model",
    path: [AUTO_NAVIGATE, name("controller_model")],
    kind: "model",
    onInvalid: "blocks",
    expects: "current or provider/id[:thinking]",
    description:
      "Model that runs the controller: current or provider/id[:thinking]. Defaults to treeProposal.model.",
    status: autoStatus("controllerModel"),
    read: (config) => autoRead(config).controllerModel ?? "current",
  },
  {
    key: "auto_navigate.check_every_turns",
    path: [AUTO_NAVIGATE, name("check_every_turns")],
    kind: "count",
    onInvalid: "blocks",
    expects: `${range(AUTO_NAVIGATE_MIN_TURNS, AUTO_NAVIGATE_MAX_TURNS)} turns`,
    description: `Check again after this many completed turns. ${range(AUTO_NAVIGATE_MIN_TURNS, AUTO_NAVIGATE_MAX_TURNS)} (default 6).`,
    status: autoStatus("checkEveryTurns"),
    read: (config) => autoRead(config).checkEveryTurns,
  },
  {
    key: "auto_navigate.min_tokens_since_anchor",
    path: [AUTO_NAVIGATE, name("min_tokens_since_anchor")],
    kind: "tokens",
    onInvalid: "blocks",
    expects: `${TOKEN_RANGE} tokens (e.g. 25k)`,
    description: `Check again after this many new tokens since the last anchor. ${TOKEN_RANGE} (default 25k).`,
    status: autoStatus("minTokensSinceAnchor"),
    read: (config) => autoRead(config).minTokensSinceAnchor,
  },
  {
    key: "auto_navigate.rewind_at_tokens",
    path: [AUTO_NAVIGATE, name("rewind_at_tokens")],
    kind: "tokens",
    onInvalid: "blocks",
    expects: `${TOKEN_RANGE} tokens (e.g. 120k)`,
    description: `Context size at which the controller may fold to an earlier anchor. ${TOKEN_RANGE} (default 120k).`,
    status: autoStatus("rewindAtTokens"),
    read: (config) => autoRead(config).rewindAtTokens,
  },
];

const MODEL_OVERRIDES_KEY = "model_overrides";
const MODEL_OVERRIDES_DESCRIPTION =
  "Per-model overrides of the reserve and auto_navigate. Edit them in the JSON file; Enter shows where.";

const isRoot = (value: unknown): value is Root =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isEnoent = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { code?: unknown }).code === "ENOENT";

const capitalized = (text: string): string =>
  text.charAt(0).toUpperCase() + text.slice(1);

// --- Raw file access: spelling-preserving reads and edits ----------------------

function findName(node: Root, part: KeyName): string | undefined {
  if (Object.hasOwn(node, part.snake)) return part.snake;
  return Object.hasOwn(node, part.camel) ? part.camel : undefined;
}

const freshName = (part: KeyName, style: Style): string =>
  (part.fresh ?? style) === "snake" ? part.snake : part.camel;

const SNAKE_MARKERS = [
  "rewind_hint_reserve_tokens",
  "anchor_start_after_turns",
  "parent_handoff_mode",
  "tree_proposal",
  "model_overrides",
];
const CAMEL_MARKERS = [
  "rewindHintReserveTokens",
  "anchorStartAfterTurns",
  "parentHandoffMode",
  "treeProposal",
  "modelOverrides",
];

/** The spelling a file uses for its top-level keys; new keys follow it. */
function styleOf(root: Root): Style {
  const used = (names: readonly string[]) =>
    names.filter((candidate) => Object.hasOwn(root, candidate)).length;
  return used(SNAKE_MARKERS) > used(CAMEL_MARKERS) ? "snake" : "camel";
}

interface Raw {
  present: boolean;
  value?: unknown;
}

function rawOf(root: Root, def: SettingDef): Raw {
  let node = root;
  for (const [index, part] of def.path.entries()) {
    const found = findName(node, part);
    if (found === undefined) return { present: false };
    const value = node[found];
    if (index === def.path.length - 1) return { present: true, value };
    if (
      typeof value === "boolean" &&
      part.shorthand === def.path[index + 1].snake
    ) {
      return { present: true, value };
    }
    if (!isRoot(value)) return { present: false };
    node = value;
  }
  return { present: false };
}

function setAt(
  root: Root,
  path: readonly KeyName[],
  value: unknown,
  style: Style,
): void {
  let node = root;
  for (const [index, part] of path.entries()) {
    const key = findName(node, part) ?? freshName(part, style);
    if (index === path.length - 1) {
      node[key] = value;
      return;
    }
    let child = node[key];
    if (typeof child === "boolean" && part.shorthand !== undefined) {
      child = { [part.shorthand]: child };
    }
    const next = isRoot(child) ? child : {};
    node[key] = next;
    node = next;
  }
}

/** Removes every spelling of the key, then any container that this left empty. */
function removeAt(root: Root, path: readonly KeyName[]): void {
  const trail: { parent: Root; key: string }[] = [];
  let node = root;
  for (const [index, part] of path.entries()) {
    const key = findName(node, part);
    if (key === undefined) return;
    const child = node[key];
    const leaf = index === path.length - 1;
    const standsForLeaf =
      typeof child === "boolean" && part.shorthand === path[index + 1]?.snake;
    if (leaf || standsForLeaf) {
      for (const spelling of new Set([part.snake, part.camel])) {
        Reflect.deleteProperty(node, spelling);
      }
      break;
    }
    if (!isRoot(child)) return;
    trail.push({ parent: node, key });
    node = child;
  }
  for (const { parent, key } of trail.reverse()) {
    const child = parent[key];
    if (!isRoot(child) || Object.keys(child).length > 0) break;
    Reflect.deleteProperty(parent, key);
  }
}

type Edit = { kind: "set"; value: unknown } | { kind: "reset" };

function applyEdit(root: Root, def: SettingDef, edit: Edit): Root {
  const next = structuredClone(root);
  if (edit.kind === "reset") removeAt(next, def.path);
  else setAt(next, def.path, edit.value, styleOf(root));
  return next;
}

const sameRaw = (a: Raw, b: Raw): boolean =>
  a.present === b.present &&
  JSON.stringify(a.value) === JSON.stringify(b.value);

interface Change {
  def: SettingDef;
  edit: Edit;
  before: Raw;
  after: Raw;
}

interface Plan {
  next: Root;
  changes: Change[];
}

/** The edits that actually change this file, applied in display order. */
function planChanges(root: Root, staged: ReadonlyMap<string, Edit>): Plan {
  let next = root;
  const changes: Change[] = [];
  for (const def of SETTINGS) {
    const edit = staged.get(def.key);
    if (!edit) continue;
    const candidate = applyEdit(next, def, edit);
    const before = rawOf(next, def);
    const after = rawOf(candidate, def);
    if (sameRaw(before, after)) continue;
    next = candidate;
    changes.push({ def, edit, before, after });
  }
  return { next, changes };
}

const serialize = (root: Root): string => `${JSON.stringify(root, null, 2)}\n`;

// --- Reading both layers --------------------------------------------------------

type FileState =
  | { kind: "missing" }
  | { kind: "ok"; text: string; root: Root }
  | { kind: "broken"; text?: string; reason: string };

async function readFileState(
  read: (path: string) => Promise<string>,
  path: string,
): Promise<FileState> {
  let text: string;
  try {
    text = await read(path);
  } catch (error) {
    if (isEnoent(error)) return { kind: "missing" };
    return {
      kind: "broken",
      reason: `could not be read (${messageOf(error)})`,
    };
  }
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (error) {
    return {
      kind: "broken",
      text,
      reason: `is not valid JSON (${messageOf(error)})`,
    };
  }
  if (!isRoot(root)) {
    return { kind: "broken", text, reason: "must be a JSON object" };
  }
  return { kind: "ok", text, root };
}

interface Resolution {
  config: Loaded;
  layers: Record<Layer, ParsedLayer | undefined>;
}

function parseLayer(text: string | undefined): ParsedLayer | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed = parseTreeNavigatorConfig(JSON.parse(text));
    return parsed.kind === "fields" ? parsed.layer : undefined;
  } catch {
    return undefined;
  }
}

interface Snapshot {
  cwd: string;
  paths: Record<Layer, string>;
  trusted: boolean;
  files: Record<Layer, FileState>;
  current: Resolution;
}

const textOf = (file: FileState): string | undefined =>
  file.kind === "missing" ? undefined : file.text;

/** Runs the real loader over in-memory texts, so values match what a session would load. */
async function resolve(
  paths: Record<Layer, string>,
  trusted: boolean,
  texts: Record<Layer, string | undefined>,
): Promise<Resolution> {
  const { config } = await loadTreeNavigatorConfig({
    agentDir: dirname(paths.global),
    projectPath: paths.project,
    projectTrusted: trusted,
    async readFile(path) {
      const text = path === paths.global ? texts.global : texts.project;
      if (text === undefined) {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      }
      return text;
    },
  });
  return {
    config,
    layers: {
      global: parseLayer(texts.global),
      project: trusted ? parseLayer(texts.project) : undefined,
    },
  };
}

async function readSnapshot(
  ctx: ExtensionCommandContext,
  deps: SettingsScreenDeps,
): Promise<Snapshot> {
  const where = deps.locations(ctx);
  const read = deps.readFile ?? ((path) => fsReadFile(path, "utf8"));
  const paths: Record<Layer, string> = {
    global: join(where.agentDir, TREE_NAVIGATOR_CONFIG_FILENAME),
    project: where.projectPath,
  };
  const files: Record<Layer, FileState> = {
    global: await readFileState(read, paths.global),
    project: where.projectTrusted
      ? await readFileState(read, paths.project)
      : { kind: "missing" },
  };
  return {
    cwd: ctx.cwd,
    paths,
    trusted: where.projectTrusted,
    files,
    current: await resolve(paths, where.projectTrusted, {
      global: textOf(files.global),
      project: textOf(files.project),
    }),
  };
}

// --- Effective values and where they come from ---------------------------------

interface Resolved {
  value: unknown;
  source: Source;
}

function resolveDef(def: SettingDef, resolution: Resolution): Resolved {
  const layers = (["project", "global"] as const).map((layer) => ({
    layer,
    status: resolution.layers[layer]
      ? def.status(resolution.layers[layer])
      : ABSENT,
  }));
  let source: Source = "default";
  const blocking =
    def.onInvalid === "blocks" &&
    layers.find(({ status }) => status.kind === "invalid");
  if (blocking) source = blocking.layer;
  else {
    const claimed = layers.find(
      ({ status }) =>
        status.kind === "set" ||
        (status.kind === "invalid" && def.onInvalid === "claims"),
    );
    if (claimed) source = claimed.layer;
  }
  return { value: def.read(resolution.config), source };
}

const INVALID_TEXT: Record<SettingDef["onInvalid"], string> = {
  claims: "invalid value, treated as off",
  "falls-through": "invalid value, ignored",
  blocks: "invalid value",
};

function show(def: SettingDef, value: unknown): string {
  if (value === undefined) return "invalid";
  if (value === null) return "off";
  if (typeof value === "number" && def.kind === "tokens") return tokens(value);
  return String(value);
}

function layerSummary(def: SettingDef, snap: Snapshot, layer: Layer): string {
  if (layer === "project" && !snap.trusted) return "untrusted";
  const file = snap.files[layer];
  if (file.kind === "broken") return "file invalid";
  const parsed = snap.current.layers[layer];
  const status = parsed ? def.status(parsed) : ABSENT;
  if (status.kind === "invalid") return "invalid";
  if (file.kind !== "ok" || status.kind === "absent") return "unset";
  return show(def, rawOf(file.root, def).value);
}

/** The first layer whose value this setting rejected, with the parser's reason when it gave one. */
function invalidIn(
  def: SettingDef,
  snap: Snapshot,
): { layer: Layer; error?: string } | undefined {
  for (const layer of ["project", "global"] as const) {
    const parsed = snap.current.layers[layer];
    const status = parsed ? def.status(parsed) : ABSENT;
    if (status.kind === "invalid") return { layer, error: status.error };
  }
  return undefined;
}

// --- The screen ----------------------------------------------------------------

function shortPath(path: string, cwd: string): string {
  const home = homedir();
  if (path.startsWith(`${cwd}${sep}`)) return `.${path.slice(cwd.length)}`;
  if (path.startsWith(`${home}${sep}`)) return `~${path.slice(home.length)}`;
  return path;
}

function brokenNotice(snap: Snapshot, layer: Layer): string {
  const file = snap.files[layer];
  const reason = file.kind === "broken" ? file.reason : "is not usable";
  return `${capitalized(layer)} config at ${snap.paths[layer]} ${reason}. It is ignored and will not be edited here. Fix the file, then reopen /anchor settings.`;
}

/** Why edits to this layer are refused right now, or undefined when they may proceed. */
function targetProblem(snap: Snapshot, target: Layer): string | undefined {
  if (target === "project" && !snap.trusted) {
    return "This project is not trusted, so its tree-navigator.json is not read or edited.";
  }
  return snap.files[target].kind === "broken"
    ? brokenNotice(snap, target)
    : undefined;
}

function planFor(
  snap: Snapshot,
  target: Layer,
  staged: ReadonlyMap<string, Edit>,
): Plan | undefined {
  const file = snap.files[target];
  if (file.kind === "broken") return undefined;
  return planChanges(file.kind === "ok" ? file.root : {}, staged);
}

function overrideKeys(file: FileState): string[] {
  if (file.kind !== "ok") return [];
  const overrides = Object.hasOwn(file.root, "model_overrides")
    ? file.root.model_overrides
    : file.root.modelOverrides;
  return isRoot(overrides) ? Object.keys(overrides) : [];
}

function overridesRow(snap: Snapshot): FrameRow {
  const total = new Set(
    LAYERS.flatMap((layer) => overrideKeys(snap.files[layer])),
  ).size;
  const project = snap.trusted
    ? overrideKeys(snap.files.project).length
    : "untrusted";
  return {
    label: MODEL_OVERRIDES_KEY,
    value:
      total === 0 ? "none" : `${total} ${total === 1 ? "entry" : "entries"}`,
    tone: "muted",
    detail: `global ${overrideKeys(snap.files.global).length} · project ${project} (read-only here)`,
    description: MODEL_OVERRIDES_DESCRIPTION,
  };
}

interface View {
  snap: Snapshot;
  target: Layer;
  staged: ReadonlyMap<string, Edit>;
  plan: Plan | undefined;
  preview: Resolution;
}

function settingRow(def: SettingDef, view: View): FrameRow {
  const { snap, target, staged, plan, preview } = view;
  const before = resolveDef(def, snap.current);
  const after = resolveDef(def, preview);
  const beforeText = show(def, before.value);
  const afterText = show(def, after.value);
  const edit = staged.get(def.key);
  const isStaged = plan
    ? plan.changes.some((change) => change.def === def)
    : edit !== undefined;
  const changed = beforeText !== afterText;
  const shadowed = isStaged && edit?.kind === "set" && after.source !== target;
  const invalid = invalidIn(def, snap);

  let detail = LAYERS.map(
    (layer) => `${layer} ${layerSummary(def, snap, layer)}`,
  ).join(" · ");
  if (invalid) {
    detail = `${invalid.layer}: ${invalid.error ?? INVALID_TEXT[def.onInvalid]}`;
  }
  if (shadowed) {
    detail = `staged ${target} value is overridden by the ${after.source} file`;
  }

  return {
    label: def.key,
    value: changed
      ? `${beforeText} → ${afterText}`
      : `${afterText} · ${after.source}`,
    tone:
      invalid || after.value === undefined
        ? "warning"
        : isStaged || changed
          ? "accent"
          : after.source === "default"
            ? "muted"
            : "text",
    detail,
    description: def.description,
  };
}

function badgeOf(view: View): string {
  const { snap, target, staged, plan } = view;
  const pending = plan ? plan.changes.length : staged.size;
  const where = targetProblem(snap, target)
    ? `target: ${target} · file invalid`
    : `target: ${target}`;
  return pending > 0 ? `${pending} staged · ${where}` : where;
}

function buildScreen(view: View, cursor: number): FrameScreen {
  const { snap, target, staged, plan } = view;
  const other: Layer = target === "global" ? "project" : "global";
  const isStaged = (index: number): boolean => {
    const def = SETTINGS[index];
    if (!def) return false;
    return plan
      ? plan.changes.some((change) => change.def === def)
      : staged.has(def.key);
  };
  const file = snap.files[target];
  const pending = plan ? plan.changes.length : staged.size;
  return {
    breadcrumbs: ["Anchor", "Settings"],
    rightBadge: badgeOf(view),
    placeholder: `Filter settings · file: ${shortPath(snap.paths[target], snap.cwd)}`,
    enterAction: "edit",
    rows: [...SETTINGS.map((def) => settingRow(def, view)), overridesRow(snap)],
    cursor,
    shortcuts: [
      { key: "t", action: `to ${other}`, enabled: () => snap.trusted },
      {
        key: "u",
        action: "unstage",
        enabled: (_row, index) => isStaged(index),
      },
      {
        key: "d",
        action: "default",
        enabled: (_row, index) => {
          const def = SETTINGS[index];
          return (
            def !== undefined &&
            file.kind === "ok" &&
            rawOf(file.root, def).present &&
            staged.get(def.key)?.kind !== "reset"
          );
        },
      },
      { key: "s", action: "save", enabled: () => pending > 0 },
    ],
  };
}

// --- Input ---------------------------------------------------------------------

const OFF_WORDS = new Set([
  "off",
  "disabled",
  "disable",
  "none",
  "no",
  "false",
  "null",
]);

/** `50k`, `1.5m`, `50,000`, `50 000`, `50_000` or `50000`; undefined when it is no whole number. */
function parseCount(text: string): number | undefined {
  const compact = text.toLowerCase().replace(/[\s_]/g, "");
  const match = /^(\d+(?:\.\d+)?|\d{1,3}(?:,\d{3})+)([km])?$/.exec(compact);
  if (!match) return undefined;
  const factor = match[2] === "k" ? 1_000 : match[2] === "m" ? 1_000_000 : 1;
  const value = Number(match[1].replace(/,/g, "")) * factor;
  const whole = Math.round(value);
  return Math.abs(value - whole) < 1e-6 ? whole : undefined;
}

function parseInput(def: SettingDef, text: string): unknown {
  const lower = text.toLowerCase();
  if (def.off && OFF_WORDS.has(lower)) return null;
  if (def.kind === "tokens" || def.kind === "count") return parseCount(text);
  const unquoted = text.replace(/^["']+|["']+$/g, "").trim();
  return def.kind === "model" && unquoted.toLowerCase() === "current"
    ? "current"
    : unquoted;
}

/** True when the real parsers accept `value` for this setting. */
function accepts(def: SettingDef, value: unknown): boolean {
  const probe: Root = {};
  setAt(probe, def.path, value, "camel");
  const parsed = parseTreeNavigatorConfig(probe);
  return parsed.kind === "fields" && def.status(parsed.layer).kind === "set";
}

async function promptEdit(
  ctx: ExtensionCommandContext,
  def: SettingDef,
  current: string,
  target: Layer,
): Promise<Edit | undefined> {
  if (def.kind === "flag") {
    return { kind: "set", value: current !== "true" };
  }
  if (def.kind === "choice" && def.choices) {
    const next =
      def.choices[(def.choices.indexOf(current) + 1) % def.choices.length];
    return { kind: "set", value: next };
  }
  const input = await ctx.ui.input(
    `${def.key} (${target} file)`,
    `now ${current} · ${def.expects}`,
  );
  const text = input?.trim();
  if (!text) return undefined;
  const value = parseInput(def, text);
  if (value === undefined || !accepts(def, value)) {
    ctx.ui.notify(
      `"${text}" is not valid for ${def.key}. Use ${def.expects}.`,
      "warning",
    );
    return undefined;
  }
  return { kind: "set", value };
}

// --- Saving --------------------------------------------------------------------

async function writeAtomically(path: string, text: string): Promise<void> {
  const target = await realpath(path).catch(() => path);
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fsWriteFile(temp, text, { encoding: "utf8", flag: "wx" });
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

const rawText = (def: SettingDef, raw: Raw): string =>
  raw.present ? show(def, raw.value) : "unset";

function changeLines(changes: readonly Change[]): string {
  return changes
    .map(({ def, edit, before, after }) => {
      const to = edit.kind === "reset" ? "removed" : rawText(def, after);
      return `${def.key}: ${rawText(def, before)} → ${to}`;
    })
    .join("\n");
}

/** "written" when the file changed, "unchanged" when it already had the values, "kept" when nothing was saved. */
async function save(
  ctx: ExtensionCommandContext,
  deps: SettingsScreenDeps,
  target: Layer,
  staged: ReadonlyMap<string, Edit>,
): Promise<"written" | "unchanged" | "kept"> {
  const prepare = async () => {
    const snap = await readSnapshot(ctx, deps);
    const problem = targetProblem(snap, target);
    const plan = problem ? undefined : planFor(snap, target, staged);
    return { snap, problem, plan };
  };
  const first = await prepare();
  if (first.problem !== undefined || !first.plan) {
    ctx.ui.notify(first.problem ?? "Nothing to save.", "warning");
    return "kept";
  }
  const path = first.snap.paths[target];
  if (first.plan.changes.length === 0) {
    ctx.ui.notify(`Nothing to save: ${path} already has these values.`, "info");
    return "unchanged";
  }
  const { changes } = first.plan;
  const confirmed = await ctx.ui.confirm(
    `Save ${changes.length} ${changes.length === 1 ? "change" : "changes"} to the ${target} config?`,
    `${path}\n\n${changeLines(changes)}\n\nAll other keys stay as they are.`,
  );
  if (!confirmed) return "kept";

  // The file may have changed while the dialog was open: write onto what is there now.
  const final = await prepare();
  if (final.problem !== undefined || !final.plan) {
    ctx.ui.notify(final.problem ?? "Nothing to save.", "warning");
    return "kept";
  }
  try {
    await (deps.writeFile ?? writeAtomically)(path, serialize(final.plan.next));
  } catch (error) {
    ctx.ui.notify(
      `Could not write ${path}: ${messageOf(error)}. The file was not changed.`,
      "error",
    );
    return "kept";
  }
  ctx.ui.notify(
    `Saved ${changes.length} ${changes.length === 1 ? "setting" : "settings"} to ${path}. The new values apply from the next session start.`,
    "info",
  );
  const saved = await readSnapshot(ctx, deps);
  const overridden = changes.filter(
    ({ def, edit }) =>
      edit.kind === "set" && resolveDef(def, saved.current).source !== target,
  );
  if (overridden.length > 0) {
    ctx.ui.notify(
      `Still overridden by the project file: ${overridden.map(({ def }) => def.key).join(", ")}.`,
      "warning",
    );
  }
  return "written";
}

/** Offer a reload so the saved values apply now; true when the session was reloaded. */
async function offerReload(ctx: ExtensionCommandContext): Promise<boolean> {
  if (!ctx.isIdle()) {
    ctx.ui.notify(
      "Run /reload when the agent is idle to apply the saved values now.",
      "info",
    );
    return false;
  }
  const reload = await ctx.ui.confirm(
    "Reload now to apply?",
    "Reloads extensions, skills and prompts in this session so the saved values take effect.",
  );
  if (!reload) return false;
  try {
    await ctx.reload();
    return true;
  } catch (error) {
    ctx.ui.notify(`Reload failed: ${messageOf(error)}`, "error");
    return false;
  }
}

// --- The loop ------------------------------------------------------------------

/** Edit tree-navigator.json settings in staged changes until the user leaves. */
export async function openSettingsScreen(
  ctx: ExtensionCommandContext,
  deps: SettingsScreenDeps,
): Promise<ScreenExit> {
  const staged = new Map<string, Edit>();
  const warned = new Set<Layer>();
  let target: Layer = "global";
  let cursor = 0;
  while (true) {
    const snap = await readSnapshot(ctx, deps);
    for (const layer of LAYERS) {
      if (snap.files[layer].kind === "broken" && !warned.has(layer)) {
        warned.add(layer);
        ctx.ui.notify(brokenNotice(snap, layer), "warning");
      }
    }
    if (target === "project" && !snap.trusted) target = "global";
    const plan = planFor(snap, target, staged);
    const preview =
      plan && plan.changes.length > 0
        ? await resolve(snap.paths, snap.trusted, {
            global: textOf(snap.files.global),
            project: textOf(snap.files.project),
            [target]: serialize(plan.next),
          })
        : snap.current;
    const view: View = { snap, target, staged, plan, preview };
    const pending = plan ? plan.changes.length : staged.size;

    const choice = await selectFrame(ctx, buildScreen(view, cursor));
    if (!choice) {
      if (pending === 0) return "back";
      const discard = await ctx.ui.confirm(
        "Discard staged changes?",
        `${pending} staged ${pending === 1 ? "change has" : "changes have"} not been saved.`,
      );
      if (discard) return "back";
      continue;
    }
    cursor = choice.index;
    const def = SETTINGS[choice.index];

    if (choice.key === "t") {
      target = target === "global" ? "project" : "global";
    } else if (choice.key === "s") {
      const saved = await save(ctx, deps, target, staged);
      if (saved !== "kept") staged.clear();
      if (saved === "written" && (await offerReload(ctx))) return "done";
    } else if (!def) {
      ctx.ui.notify(
        `model_overrides is edited by hand. Global: ${snap.paths.global}; project: ${snap.paths.project}. Keys are provider/model ids or patterns; see the README, Per-model reserve.`,
        "info",
      );
    } else if (choice.key === "u") {
      staged.delete(def.key);
    } else if (choice.key === "d") {
      stage(ctx, snap, target, staged, def, { kind: "reset" });
    } else {
      const problem = targetProblem(snap, target);
      if (problem !== undefined) {
        ctx.ui.notify(problem, "warning");
        continue;
      }
      const current = show(def, resolveDef(def, preview).value);
      const edit = await promptEdit(ctx, def, current, target);
      if (edit) stage(ctx, snap, target, staged, def, edit);
    }
  }
}

/** Stage an edit, or say why nothing is staged. */
function stage(
  ctx: ExtensionCommandContext,
  snap: Snapshot,
  target: Layer,
  staged: Map<string, Edit>,
  def: SettingDef,
  edit: Edit,
): void {
  const problem = targetProblem(snap, target);
  if (problem !== undefined) {
    ctx.ui.notify(problem, "warning");
    return;
  }
  const file = snap.files[target];
  const plan = planChanges(
    file.kind === "ok" ? file.root : {},
    new Map([[def.key, edit]]),
  );
  if (plan.changes.length === 0) {
    staged.delete(def.key);
    ctx.ui.notify(
      `No change: the ${target} file already has this value for ${def.key}.`,
      "info",
    );
    return;
  }
  staged.set(def.key, edit);
}
