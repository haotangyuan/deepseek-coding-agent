export const PROMPT_PROFILES = ["pi", "deepseek"] as const;
export type PromptProfile = (typeof PROMPT_PROFILES)[number];

export const DEFAULT_PROMPT_PROFILE: PromptProfile = "pi";

export const DEEPSEEK_CODING_PROMPT = `<deepseek_coding_workflow>
- Inspect relevant files before editing; prefer narrow reads and searches over broad scans.
- Preserve existing user changes and keep edits within the requested scope.
- After editing, inspect the resulting diff and run the narrowest relevant validation when allowed.
- Do not claim success without evidence; report skipped or failed checks explicitly.
- Avoid repeating the same tool call unless new information justifies it.
</deepseek_coding_workflow>`;

export function applyPromptProfile(profile: PromptProfile, base: string[]): string[] {
  if (profile === "pi") return base;
  return [DEEPSEEK_CODING_PROMPT, ...base];
}
