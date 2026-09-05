/**
 * pi-git-safeguard — a pi coding-agent extension
 *
 * Blocks git write operations and GitHub CLI mutations unless the user
 * explicitly approves them in an interactive session. In non-interactive
 * mode (`pi -p` / `--print`), every matched command is hard-blocked.
 *
 * @license MIT
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const EXTENSION_NAME = "pi-git-safeguard";

/** What to do when a blocked command is detected. */
export type GuardMode = "block" | "warn" | "off";

/** A git/gh operation this extension considers a "write". */
export interface BlockedCommand {
  /** Human-readable category, e.g. "git commit" or "gh pr merge". */
  label: string;
  /** Regex matched against the full bash command string. */
  pattern: RegExp;
}

/**
 * Patterns matching git/GH write operations. Read-only commands
 * (status, diff, log, show, branch list, stash list, tag list, etc.)
 * never match and are never blocked.
 */
export const BLOCKED_COMMANDS: BlockedCommand[] = [
  // git commit / push
  { label: "git commit", pattern: /\bgit\s+commit\b/i },
  { label: "git push", pattern: /\bgit\s+push\b/i },
  // git rebase
  { label: "git rebase", pattern: /\bgit\s+rebase\b/i },
  // destructive resets
  {
    label: "git reset --hard/--keep/--merge",
    pattern: /\bgit\s+reset\s+--(?:hard|keep|merge)\b/i,
  },
  // history-rewriting commands
  { label: "git revert", pattern: /\bgit\s+revert\b/i },
  { label: "git cherry-pick", pattern: /\bgit\s+cherry-pick\b/i },
  { label: "git merge", pattern: /\bgit\s+merge\b/i },
  { label: "git am", pattern: /\bgit\s+am\b/i },
  { label: "git apply (patch)", pattern: /\bgit\s+apply\b/i },
  // ref mutation
  { label: "git tag delete", pattern: /\bgit\s+tag\s+(?:-d|--delete)\b/i },
  {
    label: "git branch delete/rename",
    pattern:
      /\bgit\s+branch\s+(?:-d|-D|-m|-M|--delete|--force-delete|--move)\b/i,
  },
  {
    label: "git stash drop/clear",
    pattern: /\bgit\s+stash\s+(?:drop|clear)\b/i,
  },
  { label: "git update-ref", pattern: /\bgit\s+update-ref\b/i },
  {
    label: "git symbolic-ref --delete",
    pattern: /\bgit\s+symbolic-ref\s+--delete\b/i,
  },
  { label: "git gc --aggressive", pattern: /\bgit\s+gc\b[^\n]*--aggressive/i },
  // gh CLI mutations
  {
    label: "gh pr create/merge/edit/close/ready",
    pattern: /\bgh\s+pr\s+(?:create|merge|edit|close|ready)\b/i,
  },
  {
    label: "gh pr review --approve/--request-changes",
    pattern: /\bgh\s+pr\s+review\b[^\n]*--(?:approve|request-changes)/i,
  },
  {
    label: "gh issue create/edit/close",
    pattern: /\bgh\s+issue\s+(?:create|edit|close)\b/i,
  },
  { label: "gh repo delete", pattern: /\bgh\s+repo\s+delete\b/i },
];

/** Minutes a one-shot "allow once" bypass stays valid. */
const ALLOW_ONCE_TIMEOUT_MS = 2 * 60 * 1000;

/** How long the interactive approval dialog stays open before defaulting to block. */
const DIALOG_TIMEOUT_MS = 30_000;

/** Resolve the active guard mode from the PI_GIT_SAFEGUARD environment variable. */
export function resolveGuardMode(
  env: NodeJS.ProcessEnv = process.env,
): GuardMode {
  const raw = (env.PI_GIT_SAFEGUARD ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "0" || raw === "false" || raw === "no")
    return "off";
  if (raw === "warn" || raw === "log") return "warn";
  return "block";
}

/** Check if a bash command matches a blocked git/gh operation. */
export function matchBlockedCommand(command: string): BlockedCommand | null {
  const trimmed = command.trim();
  for (const blocked of BLOCKED_COMMANDS) {
    if (blocked.pattern.test(trimmed)) return blocked;
  }
  return null;
}

/** Truncate long commands for display in dialogs. */
function preview(command: string, max = 200): string {
  return command.length > max ? `${command.slice(0, max)}…` : command;
}

/** Text shown when the guard blocks or warns about a command. */
function blockedMessage(blocked: BlockedCommand, mode: GuardMode): string {
  const verb = mode === "warn" ? "flagged" : "blocked";
  return (
    `git-safeguard: ${verb} "${blocked.label}". ` +
    `Git Safeguard prevents the agent from running git/gh write operations autonomously. ` +
    `Read-only git commands (status, diff, log, ...) are never blocked. ` +
    `Start pi interactively and approve when prompted, or set PI_GIT_SAFEGUARD=off to disable.`
  );
}

export default function gitGuardExtension(pi: ExtensionAPI): void {
  const mode = resolveGuardMode();

  if (mode === "off") return;

  // Window where a previously approved command re-runs without a new prompt.
  let lastAllowed: { command: string; expires: number } | undefined;

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;

    const command = String(event.input.command ?? "");
    if (!command) return;

    const blocked = matchBlockedCommand(command);
    if (!blocked) return;

    // "Allow once": skip the prompt if the same command was just approved.
    if (
      lastAllowed &&
      command === lastAllowed.command &&
      Date.now() < lastAllowed.expires
    ) {
      lastAllowed = undefined; // consume — ask again next time
      return;
    }

    if (mode === "warn") {
      ctx.ui.notify(
        `git-safeguard: ⚠ "${blocked.label}" is a git/gh write operation (warn mode).`,
        "warning",
      );
      return;
    }

    // Interactive: ask the user to approve.
    if (ctx.hasUI) {
      const choice = await ctx.ui.select(
        `git-safeguard: ${blocked.label} detected`,
        [`Allow once: "${preview(command)}"`, "Block this command"],
        { timeout: DIALOG_TIMEOUT_MS },
      );

      if (choice?.startsWith("Allow once")) {
        lastAllowed = { command, expires: Date.now() + ALLOW_ONCE_TIMEOUT_MS };
        return;
      }

      return {
        block: true,
        reason:
          choice === undefined
            ? `${blockedMessage(blocked, mode)} (approval dialog timed out)`
            : blockedMessage(blocked, mode),
      };
    }

    // Non-interactive: hard-block.
    return {
      block: true,
      reason: blockedMessage(blocked, mode),
    };
  });
}
