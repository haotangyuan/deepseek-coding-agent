import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGENT_MODES, APPROVAL_MODES, type AgentMode, type ApprovalMode } from "./tool-policy.ts";

export const PRODUCT_CONFIG_DIR = "deepseek-code";
export const DEFAULT_PRODUCT_MODEL = "deepseek-v4-flash";
export const PRODUCT_THINKING_LEVELS = ["off", "high", "max"] as const;
export type ProductThinkingLevel = (typeof PRODUCT_THINKING_LEVELS)[number];

export interface ProductPreferences {
  model: string;
  thinking: ProductThinkingLevel;
  mode: AgentMode;
  approval: ApprovalMode;
  showReasoning: boolean;
}

interface ProductSettingsFile {
  version: 1;
  model?: string;
  thinking?: ProductThinkingLevel;
  mode?: AgentMode;
  approval?: ApprovalMode;
  showReasoning?: boolean;
}

export const DEFAULT_PRODUCT_PREFERENCES: ProductPreferences = {
  model: DEFAULT_PRODUCT_MODEL,
  thinking: "high",
  mode: "build",
  approval: "ask",
  showReasoning: false,
};

const SETTINGS_KEYS = new Set(["version", "model", "thinking", "mode", "approval", "showReasoning"]);

function parseSettingsFile(text: string, path: string): ProductSettingsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${path}: ${message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid ${path}: expected an object`);
  }
  const record = parsed as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !SETTINGS_KEYS.has(key));
  if (unknown.length > 0) throw new Error(`Invalid ${path}: unknown field ${unknown[0]}`);
  if (record.version !== 1) throw new Error(`Invalid ${path}: version must be 1`);
  if (record.model !== undefined && (typeof record.model !== "string" || record.model.trim() === "")) {
    throw new Error(`Invalid ${path}: model must be a non-empty string`);
  }
  if (record.model === "deepseek/") throw new Error(`Invalid ${path}: model must include an id`);
  if (record.model !== undefined && record.model.includes("/") && !record.model.startsWith("deepseek/")) {
    throw new Error(`Invalid ${path}: only the deepseek provider is allowed`);
  }
  if (record.thinking !== undefined && !PRODUCT_THINKING_LEVELS.includes(record.thinking as ProductThinkingLevel)) {
    throw new Error(`Invalid ${path}: unsupported thinking value`);
  }
  if (record.mode !== undefined && !AGENT_MODES.includes(record.mode as AgentMode)) {
    throw new Error(`Invalid ${path}: unsupported mode value`);
  }
  if (record.approval !== undefined && !APPROVAL_MODES.includes(record.approval as ApprovalMode)) {
    throw new Error(`Invalid ${path}: unsupported approval value`);
  }
  if (record.showReasoning !== undefined && typeof record.showReasoning !== "boolean") {
    throw new Error(`Invalid ${path}: showReasoning must be boolean`);
  }
  return record as unknown as ProductSettingsFile;
}

function normalizeModel(model: string): string {
  return model.startsWith("deepseek/") ? model.slice("deepseek/".length) : model;
}

export class ProductSettingsStore {
  readonly path: string;
  private settings: ProductSettingsFile = { version: 1 };
  private loadError: Error | undefined;

  constructor(agentDir: string) {
    this.path = join(agentDir, PRODUCT_CONFIG_DIR, "settings.json");
    if (!existsSync(this.path)) return;
    try {
      this.settings = parseSettingsFile(readFileSync(this.path, "utf-8"), this.path);
    } catch (error) {
      this.loadError = error instanceof Error ? error : new Error(String(error));
    }
  }

  getPreferences(): ProductPreferences {
    if (this.loadError) return { ...DEFAULT_PRODUCT_PREFERENCES };
    return {
      model: normalizeModel(this.settings.model ?? DEFAULT_PRODUCT_PREFERENCES.model),
      thinking: this.settings.thinking ?? DEFAULT_PRODUCT_PREFERENCES.thinking,
      mode: this.settings.mode ?? DEFAULT_PRODUCT_PREFERENCES.mode,
      approval: this.settings.approval ?? DEFAULT_PRODUCT_PREFERENCES.approval,
      showReasoning: this.settings.showReasoning ?? DEFAULT_PRODUCT_PREFERENCES.showReasoning,
    };
  }

  getLoadError(): Error | undefined {
    return this.loadError;
  }

  update(patch: Partial<ProductPreferences>): void {
    if (this.loadError) {
      throw new Error(`Settings are read-only until the invalid file is fixed: ${this.loadError.message}`);
    }
    const next = { ...this.getPreferences(), ...patch };
    const data: ProductSettingsFile = {
      version: 1,
      model: normalizeModel(next.model),
      thinking: next.thinking,
      mode: next.mode,
      approval: next.approval,
      showReasoning: next.showReasoning,
    };
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tempPath = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
    renameSync(tempPath, this.path);
    chmodSync(this.path, 0o600);
    this.settings = data;
  }
}
