/**
 * Agent definitions — directory-based personas with built-in fallbacks.
 *
 * Directory layout (deployed by codex-workbench into <agent dir>/subagents/):
 *
 *   <name>/PERSONA.md  — frontmatter metadata (name, description, model, tools)
 *                        + the persona body
 *   <name>/AGENTS.md   — agent-specific rules (optional)
 *   <name>/SKILL.md    — skill list: required/optional entries (optional)
 *
 * The persona, rules, and resolved skills are appended to the child pi's
 * system prompt via --append-system-prompt (see agent-task.ts). The task
 * prompt itself stays a plain user message.
 *
 * Built-in fallbacks carry only name/description/model/tools — no persona.
 * They apply when no directory definition exists (degraded mode).
 *
 * Resolution order:
 *   1. <subagents root>/<name>/PERSONA.md exists → directory definition.
 *   2. Otherwise BUILTIN_AGENTS[name].
 *
 * Roots are overridable via env for tests:
 *   PI_ATLAS_SUBAGENTS_DIR — subagents root (default: <agent dir>/subagents)
 *   PI_ATLAS_SKILLS_DIRS   — colon-separated skill roots
 *                            (default: <agent dir>/skills + ~/.agents/skills)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A skill reference: name plus optional files to load alongside SKILL.md. */
export interface SkillRef {
  name: string;
  files: string[];
}

/** Skill list parsed from a SKILL.md. */
export interface AgentSkills {
  required: SkillRef[];
  optional: SkillRef[];
}

/** A resolved agent definition ready for prompt wrapping and spawn. */
export interface AgentDefinition {
  /** Agent name. */
  name: string;
  /** Short description shown in the CreateAgent tool listing. */
  description: string;
  /** Persona body (PERSONA.md) — appended to the child system prompt. */
  persona?: string;
  /** Agent rules (AGENTS.md) — appended to the child system prompt. */
  rules?: string;
  /** Skill list (SKILL.md) — resolved against this device's skill dirs. */
  skills?: AgentSkills;
  /** Legacy prompt prefix (used by custom definitions; built-ins carry none). */
  prefix?: string;
  /** Legacy prompt suffix. */
  suffix?: string;
  /** Model override (e.g. "macaronai/macaron-v1-coding-venti:low"). Omit to inherit the parent's model. */
  model?: string;
  /** Priority-ordered model list from the `models` frontmatter field; `model` is the first available pick. */
  modelPriority?: string[];
  /** Tool allowlist. */
  tools?: string[];
  /** Source directory of the definition (directory agents only). */
  sourceDir?: string;
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

/** Minimal `---\nkey: value\n---` frontmatter parser (PERSONA.md metadata, SKILL.md stripping). */
function parseSimpleFrontmatter(
  content: string,
): { meta: Record<string, string>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };
  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (m) meta[m[1]] = m[2].trim();
  }
  return { meta, body: match[2].trim() };
}

/** Read a file to trimmed text; undefined when missing or unreadable. */
function readOptionalText(filePath: string): string | undefined {
  try {
    const text = fs.readFileSync(filePath, "utf-8").trim();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Model priority lists
// ---------------------------------------------------------------------------

/**
 * Parse the model priority list from frontmatter:
 * `models: a, b, c` (priority order) or `model: x` (single entry).
 */
function parseModelPriority(meta: Record<string, string>): string[] {
  const raw = meta.models ?? meta.model ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Minimal shape of ~/.pi/agent/models.json for availability checks. */
interface ModelInventory {
  providers?: Record<string, { models?: { id: string }[] }>;
}

let cachedInventory: ModelInventory | null | undefined;

/** Load the device's model inventory; null when unreadable, cached after first load. */
function loadModelInventory(): ModelInventory | null {
  if (cachedInventory !== undefined) return cachedInventory;
  try {
    const inventoryPath = path.join(getAgentDir(), "models.json");
    cachedInventory = JSON.parse(fs.readFileSync(inventoryPath, "utf-8")) as ModelInventory;
  } catch {
    cachedInventory = null;
  }
  return cachedInventory;
}

/** Is `spec` (provider/id or id, optional ":thinking") available on this device? */
function isModelAvailable(spec: string, inventory: ModelInventory): boolean {
  const rawRef = spec.split(":")[0];
  const slash = rawRef.indexOf("/");
  const provider = slash >= 0 ? rawRef.slice(0, slash) : undefined;
  const id = slash >= 0 ? rawRef.slice(slash + 1) : rawRef;
  if (!id) return false;
  for (const [name, cfg] of Object.entries(inventory.providers ?? {})) {
    if (provider && name !== provider) continue;
    if ((cfg.models ?? []).some((m) => m.id === id)) return true;
  }
  return false;
}

/** Pick the first model from the priority list that exists in the device's models.json. */
function pickAvailableModel(priority: string[]): string | undefined {
  if (priority.length === 0) return undefined;
  const inventory = loadModelInventory();
  if (!inventory) return priority[0];
  return priority.find((m) => isModelAvailable(m, inventory));
}

// ---------------------------------------------------------------------------
// Roots
// ---------------------------------------------------------------------------

/** Root directory holding per-agent definitions. */
export function subagentsRoot(): string {
  return process.env.PI_ATLAS_SUBAGENTS_DIR ?? path.join(getAgentDir(), "subagents");
}

/** Skill roots searched on this device (pi skills + shared skills). */
export function skillSearchRoots(): string[] {
  if (process.env.PI_ATLAS_SKILLS_DIRS) {
    return process.env.PI_ATLAS_SKILLS_DIRS.split(path.delimiter)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const agentDir = getAgentDir();
  return [
    path.join(agentDir, "skills"),
    path.join(path.dirname(path.dirname(agentDir)), ".agents", "skills"),
  ];
}

// ---------------------------------------------------------------------------
// Built-in agents (fallback: name/description/model/tools only)
// ---------------------------------------------------------------------------

/** Built-in fallback definitions. Directory definitions override these. */
export const BUILTIN_AGENTS: Record<string, AgentDefinition> = {
  scout: {
    name: "scout",
    description:
      "Fast read-only codebase recon that returns compressed context for handoff to other agents",
    model: "ds-cn/deepseek-v4-flash",
    tools: ["read", "grep", "find", "ls", "bash"],
  },
  implementer: {
    name: "implementer",
    description:
      "Implementation owner for a single scoped change — gathers context, edits, verifies",
    model: "ds-cn/deepseek-v4-pro:xhigh",
    tools: ["read", "write", "edit", "bash"],
  },
  reviewer: {
    name: "reviewer",
    description:
      "Independent read-only review of code changes against requirements and correctness",
    model: "grok-cn/grok-4.6:xhigh",
    tools: ["read", "grep", "bash"],
  },
  general: {
    name: "general",
    description:
      "General-purpose agent with no special prompt — use for custom agent behavior",
  },
};

// ---------------------------------------------------------------------------
// SKILL.md parsing
// ---------------------------------------------------------------------------

/**
 * Parse a SKILL.md skill list:
 *
 *   required:
 *   - git-workflow: pr.md, review-logic.md
 *   optional:
 *   - lazy-github
 *
 * `name: f1, f2` loads those files alongside the skill's SKILL.md.
 */
export function parseSkillsList(content: string): AgentSkills {
  const skills: AgentSkills = { required: [], optional: [] };
  let section: "required" | "optional" | null = null;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    const sectionMatch = line.match(/^(required|optional)\s*:/i);
    if (sectionMatch) {
      section = sectionMatch[1].toLowerCase() as "required" | "optional";
      continue;
    }
    if (!section || !line.startsWith("- ")) continue;
    const entry = line.slice(2).trim().split(/\s*#/)[0].trim();
    if (!entry) continue;
    const colon = entry.indexOf(":");
    if (colon >= 0) {
      const name = entry.slice(0, colon).trim();
      const files = entry
        .slice(colon + 1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      skills[section].push({ name, files });
    } else {
      skills[section].push({ name: entry, files: [] });
    }
  }
  return skills;
}

// ---------------------------------------------------------------------------
// Directory-based agents
// ---------------------------------------------------------------------------

/**
 * Load a directory-based agent definition from <root>/<name>/.
 * Returns null when the directory (or its PERSONA.md) is missing.
 */
export function loadAgentDir(name: string, root: string): AgentDefinition | null {
  const dir = path.join(root, name);
  const personaText = readOptionalText(path.join(dir, "PERSONA.md"));
  if (personaText === undefined) return null;

  const { meta, body } = parseSimpleFrontmatter(personaText);
  const rules = readOptionalText(path.join(dir, "AGENTS.md"));
  const skillsText = readOptionalText(path.join(dir, "SKILL.md"));
  const skills = skillsText !== undefined ? parseSkillsList(skillsText) : undefined;

  const modelPriority = parseModelPriority(meta);

  return {
    name: meta.name ?? name,
    description: meta.description ?? name,
    persona: body,
    rules,
    skills,
    model: pickAvailableModel(modelPriority),
    modelPriority: modelPriority.length > 0 ? modelPriority : undefined,
    tools: meta.tools
      ? meta.tools.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined,
    sourceDir: dir,
  };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * List all available agents: directory definitions (they override built-ins
 * by name), built-ins as fallback.
 */
export function listAgents(): AgentDefinition[] {
  const agents = new Map<string, AgentDefinition>();
  for (const a of Object.values(BUILTIN_AGENTS)) agents.set(a.name, a);
  const root = subagentsRoot();
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    // No subagents directory — built-ins only.
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const loaded = loadAgentDir(entry.name, root);
    if (loaded) agents.set(loaded.name, loaded);
  }
  return [...agents.values()];
}

/**
 * Resolve an agent by name: directory definition first, built-in fallback.
 * Returns null when not found.
 */
export function resolveAgent(name: string): AgentDefinition | null {
  const dirAgent = loadAgentDir(name, subagentsRoot());
  if (dirAgent) return dirAgent;
  return BUILTIN_AGENTS[name] ?? null;
}

// ---------------------------------------------------------------------------
// Skill resolution (device-dependent)
// ---------------------------------------------------------------------------

/**
 * Resolve a skill list against this device's skill roots.
 * Returns system-prompt sections (one per found skill) and the names of
 * required skills missing on this device.
 */
export function resolveAgentSkills(skills: AgentSkills): {
  sections: string[];
  missingRequired: string[];
} {
  const roots = skillSearchRoots();
  const sections: string[] = [];
  const missingRequired: string[] = [];
  for (const ref of skills.required) {
    const section = loadSkillSection(roots, ref);
    if (section) sections.push(section);
    else missingRequired.push(ref.name);
  }
  for (const ref of skills.optional) {
    const section = loadSkillSection(roots, ref);
    if (section) sections.push(section);
  }
  return { sections, missingRequired };
}

/** Load one skill's SKILL.md + referenced files into a system-prompt section. */
function loadSkillSection(roots: string[], ref: SkillRef): string | undefined {
  for (const root of roots) {
    const dir = path.join(root, ref.name);
    if (!fs.existsSync(dir)) continue;
    const parts: string[] = [];
    for (const file of ["SKILL.md", ...ref.files]) {
      const text = readOptionalText(path.join(dir, file));
      if (text === undefined) continue;
      // Strip YAML frontmatter — skill metadata, not instructions.
      parts.push(parseSimpleFrontmatter(text).body);
    }
    if (parts.length > 0) {
      return `## Skill: ${ref.name}\n\n${parts.join("\n\n")}`;
    }
  }
  return undefined;
}

/**
 * Build the system-prompt append sections for an agent definition:
 * persona, rules, resolved skills, and missing-required-skill notices.
 */
export function buildAgentSections(agent: AgentDefinition): string[] {
  const sections: string[] = [];
  if (agent.persona) {
    sections.push(`<agent_persona>\n${agent.persona}\n</agent_persona>`);
  }
  if (agent.rules) {
    sections.push(`<agent_rules>\n${agent.rules}\n</agent_rules>`);
  }
  if (agent.skills) {
    const resolved = resolveAgentSkills(agent.skills);
    sections.push(...resolved.sections);
    if (resolved.missingRequired.length > 0) {
      sections.push(
        `<missing_skills>\nRequired skill(s) not found on this device: ${resolved.missingRequired.join(", ")}. Proceed without them and note the degradation in the final report.\n</missing_skills>`,
      );
    }
  }
  return sections;
}

// ---------------------------------------------------------------------------
// Prompt wrapping (legacy prefix/suffix support)
// ---------------------------------------------------------------------------

/**
 * Wrap a task prompt with the agent's prefix and suffix.
 *
 * effective_prompt = [prefix]\n\n[prompt]\n\n[suffix]
 * If the agent has no prefix/suffix (directory agents, general), returns the
 * prompt as-is.
 */
export function wrapPrompt(
  prompt: string,
  agent: Pick<AgentDefinition, "prefix" | "suffix">,
): string {
  const parts: string[] = [];
  if (agent.prefix) parts.push(agent.prefix.trim());
  parts.push(prompt);
  if (agent.suffix) parts.push(agent.suffix.trim());
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Catalog formatting (for tool description)
// ---------------------------------------------------------------------------

/**
 * Format the agent list as a human/LLM-readable catalog.
 * Used to inject available agents into the CreateAgent tool description.
 */
export function formatAgentCatalog(agents: AgentDefinition[]): string {
  const lines = agents.map((a) => `- ${a.name}: ${a.description}`);
  return lines.join("\n");
}
