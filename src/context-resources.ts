import type {
  PromptTemplate,
  ResourceDiagnostic,
  ResourceLoader,
  Skill,
} from "@earendil-works/pi-coding-agent";
import { isAbsolute, relative, resolve } from "node:path";

export type ResourceScope = "user" | "ancestor" | "project" | "temporary";

export interface ContextResourceItem {
  name: string;
  path: string;
  scope: ResourceScope;
  description?: string;
  characters?: number;
  modelInvocable?: boolean;
}

export interface ContextSnapshot {
  projectResourcesEnabled: boolean;
  systemPromptCharacters: number;
  estimatedSystemPromptTokens: number;
  activeTools: string[];
  agentsFiles: ContextResourceItem[];
  skills: ContextResourceItem[];
  prompts: ContextResourceItem[];
  diagnostics: ResourceDiagnostic[];
}

export interface ProjectResourceFilter {
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
  skillsOverride(base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }): {
    skills: Skill[];
    diagnostics: ResourceDiagnostic[];
  };
  promptsOverride(base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }): {
    prompts: PromptTemplate[];
    diagnostics: ResourceDiagnostic[];
  };
  agentsFilesOverride(base: { agentsFiles: Array<{ path: string; content: string }> }): {
    agentsFiles: Array<{ path: string; content: string }>;
  };
}

function isInside(root: string, target: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(target));
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

function filterDiagnostics(
  diagnostics: ResourceDiagnostic[],
  cwd: string,
  projectResourcesEnabled: boolean,
): ResourceDiagnostic[] {
  if (projectResourcesEnabled) return diagnostics;
  return diagnostics.filter((diagnostic) => !diagnostic.path || !isInside(cwd, diagnostic.path));
}

export function createProjectResourceFilter(cwd: string, agentDir: string): ProjectResourceFilter {
  let projectResourcesEnabled = true;
  return {
    isEnabled: () => projectResourcesEnabled,
    setEnabled: (enabled) => {
      projectResourcesEnabled = enabled;
    },
    skillsOverride: (base) => ({
      skills: projectResourcesEnabled ? base.skills : base.skills.filter((skill) => skill.sourceInfo.scope !== "project"),
      diagnostics: filterDiagnostics(base.diagnostics, cwd, projectResourcesEnabled),
    }),
    promptsOverride: (base) => ({
      prompts: projectResourcesEnabled
        ? base.prompts
        : base.prompts.filter((prompt) => prompt.sourceInfo.scope !== "project"),
      diagnostics: filterDiagnostics(base.diagnostics, cwd, projectResourcesEnabled),
    }),
    agentsFilesOverride: (base) => ({
      agentsFiles: projectResourcesEnabled
        ? base.agentsFiles
        : base.agentsFiles.filter((agentsFile) => isInside(agentDir, agentsFile.path)),
    }),
  };
}

function classifyPath(path: string, cwd: string, agentDir: string): ResourceScope {
  if (isInside(cwd, path)) return "project";
  if (isInside(agentDir, path)) return "user";
  return "ancestor";
}

export function captureContextSnapshot(options: {
  loader: ResourceLoader;
  cwd: string;
  agentDir: string;
  projectResourcesEnabled: boolean;
  effectiveSystemPrompt: string;
  activeTools: string[];
}): ContextSnapshot {
  const agentsFiles = options.loader.getAgentsFiles().agentsFiles.map((file) => ({
    name: file.path.split(/[\\/]/).pop() ?? file.path,
    path: file.path,
    scope: classifyPath(file.path, options.cwd, options.agentDir),
    characters: file.content.length,
  }));
  const skillResult = options.loader.getSkills();
  const promptResult = options.loader.getPrompts();
  const skills = skillResult.skills.map((skill) => ({
    name: skill.name,
    path: skill.filePath,
    scope: skill.sourceInfo.scope,
    description: skill.description,
    modelInvocable: !skill.disableModelInvocation,
  }));
  const prompts = promptResult.prompts.map((prompt) => ({
    name: prompt.name,
    path: prompt.filePath,
    scope: prompt.sourceInfo.scope,
    description: prompt.description,
    characters: prompt.content.length,
  }));
  return {
    projectResourcesEnabled: options.projectResourcesEnabled,
    systemPromptCharacters: options.effectiveSystemPrompt.length,
    estimatedSystemPromptTokens: Math.ceil(options.effectiveSystemPrompt.length / 4),
    activeTools: [...options.activeTools],
    agentsFiles,
    skills,
    prompts,
    diagnostics: [...skillResult.diagnostics, ...promptResult.diagnostics],
  };
}
