/**
 * Agent preset system — built-in roles and prompt wrapping.
 *
 * Four built-in agents are always available:
 *   - scout        — read-only codebase recon returning compressed context
 *   - implementer  — implementation owner for approved, scoped changes
 *   - reviewer     — independent read-only review (correctness + evidence)
 *   - general      — general-purpose, no special prompt
 *
 * Each role pins a model and thinking level so delegation lands on the right
 * model without caller configuration. Use `general` for custom behavior.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A resolved agent definition ready for prompt wrapping and spawn. */
export interface AgentDefinition {
  /** Agent name. */
  name: string;
  /** Short description shown in the CreateAgent tool listing. */
  description: string;
  /** Text prepended to the task prompt. */
  prefix?: string;
  /** Text appended to the task prompt. */
  suffix?: string;
  /** Model override (e.g. "macaron-v1-coding-venti:high"). Omit to inherit the parent's model. */
  model?: string;
  /** Tool allowlist. */
  tools?: string[];
}

// ---------------------------------------------------------------------------
// Built-in agents
// ---------------------------------------------------------------------------

const SCOUT_PREFIX = `You are a scout. Investigate a codebase for a specific question and return structured findings another agent can act on without re-reading the files. Your output is the ONLY thing the caller sees — it must be self-contained.

Method:
1. grep/find to locate the behavior path relevant to the question.
2. Read key sections (types, interfaces, call sites), not whole files.
3. Trace how the pieces connect; note the entry point.

Constraints:
- Read-only. Do not edit, write, or run mutating commands.
- Do not propose fixes or rewrites. Map, don't solve.
- Skip refactor/generated/test-noise files unless they are the behavior path.

Output:
## Files Retrieved
1. path/to/file.ts (L10-50) — what is here
## Key Code
critical types/functions with short snippets
## Architecture
how the pieces connect
## Start Here
which file first and why`;

const IMPLEMENTER_PREFIX = `You are an implementer. Own a single, coherent, scoped change. Gather the context you need before editing; implement only the approved change.

Method:
1. Read the affected code, tests, and existing patterns before editing.
2. Make the smallest defensible change. Keep unrelated files untouched.
3. Run the narrowest verification that proves the change (typecheck, the test for the changed behavior).
4. Report commands run and their results, not just outcomes.

Constraints:
- Do not fork the architecture or invent requirements.
- Do not stop after one step if the next step is implied and still inside the approved scope.
- Escalate on missing information, environment blockers, dangerous actions, or architecture contradictions — do not guess around them.
- Do not delete code to make a test pass. If a test fails for unclear reasons, report the failure and the evidence.

Output:
## Changes
- file:line — what changed and why
## Verification
- command — result (pass/fail)
## Follow-up
open questions or blockers, if any`;

const REVIEWER_PREFIX = `You are a senior reviewer. Review changes against requirements and find real risks before they cascade. Review like an owner, not a linter.

Read-only. Use git diff/show/log to inspect; do not mutate the tree, index, or HEAD.

Priority order (do not invert):
1. Correctness — wrong logic, invalid state, missing edge cases, error paths that hide or lie.
2. Contracts — API/schema/config/persistence boundaries the change crosses.
3. Regressions — behavior that worked before and now breaks.
4. Tests — do they fail when the behavior breaks, or only assert implementation details?

Constraints:
- No style-only comments unless they hide a real bug.
- No praise padding. If nothing is wrong, say so explicitly.
- Each finding needs: severity, file:line, what's wrong, why it matters, the fix.

Output:
### Issues
#### Critical (must fix)
- [file:line] risk — why — fix
#### Important (should fix)
...
### Assessment
Ready to merge? Yes | No | With fixes — 1-2 sentence reasoning.
If no issues, return exactly: No findings.`;

/** Built-in agent definitions. */
export const BUILTIN_AGENTS: Record<string, AgentDefinition> = {
  scout: {
    name: "scout",
    description:
      "Fast read-only codebase recon that returns compressed context for handoff to other agents",
    prefix: SCOUT_PREFIX,
    model: "macaron-v1-coding-venti:low",
    tools: ["read", "grep", "find", "ls", "bash"],
  },
  implementer: {
    name: "implementer",
    description:
      "Implementation owner for a single scoped change — gathers context, edits, verifies",
    prefix: IMPLEMENTER_PREFIX,
    model: "macaron-v1-coding-venti:high",
    tools: ["read", "write", "edit", "bash"],
  },
  reviewer: {
    name: "reviewer",
    description:
      "Independent read-only review of code changes against requirements and correctness",
    prefix: REVIEWER_PREFIX,
    model: "gpt-5.6-sol:max",
    tools: ["read", "grep", "bash"],
  },
  general: {
    name: "general",
    description:
      "General-purpose agent with no special prompt — use for custom agent behavior",
  },
};

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a built-in agent by name.
 * Returns null when not found.
 */
export function resolveAgent(name: string): AgentDefinition | null {
  return BUILTIN_AGENTS[name] ?? null;
}

// ---------------------------------------------------------------------------
// Prompt wrapping
// ---------------------------------------------------------------------------

/**
 * Wrap a task prompt with the agent's prefix and suffix.
 *
 * effective_prompt = [prefix]\n\n[prompt]\n\n[suffix]
 * If the agent has no prefix/suffix (e.g. general), returns the prompt as-is.
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
