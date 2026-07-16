import {
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
  type ProjectTrustStoreEntry,
} from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ContextResourceItem } from "./context-resources.ts";
import { PRODUCT_CONFIG_DIR } from "./product-settings.ts";
import { PROJECT_VALIDATION_CONFIG } from "./validation-suggestions.ts";

export type ProductProjectTrustStatus = "trusted" | "untrusted" | "undecided" | "error";

export interface ProductProjectTrustSnapshot {
  status: ProductProjectTrustStatus;
  remembered: boolean;
  savedPath?: string;
  error?: string;
}

export class ProductProjectTrust {
  private readonly cwd: string;
  private readonly store: ProjectTrustStore;
  private entry: ProjectTrustStoreEntry | null = null;
  private sessionDecision: boolean | undefined;
  private error: Error | undefined;

  constructor(cwd: string, agentDir: string) {
    this.cwd = cwd;
    this.store = new ProjectTrustStore(join(agentDir, PRODUCT_CONFIG_DIR));
    try {
      this.entry = this.store.getEntry(cwd);
    } catch (error) {
      this.error = error instanceof Error ? error : new Error(String(error));
    }
  }

  hasTrustRequiringResources(): boolean {
    return hasTrustRequiringProjectResources(this.cwd) || this.getProductResources().length > 0;
  }

  getProductResources(): ContextResourceItem[] {
    const path = join(this.cwd, PROJECT_VALIDATION_CONFIG);
    return existsSync(path)
      ? [{
          name: "validation.json",
          path,
          scope: "project",
          description: "Project-defined validation commands",
        }]
      : [];
  }

  isTrusted(): boolean {
    return this.sessionDecision ?? this.entry?.decision ?? false;
  }

  snapshot(): ProductProjectTrustSnapshot {
    if (this.error) return { status: "error", remembered: false, error: this.error.message };
    const decision = this.sessionDecision ?? this.entry?.decision;
    return {
      status: decision === undefined ? "undecided" : decision ? "trusted" : "untrusted",
      remembered: this.sessionDecision === undefined && this.entry !== null,
      savedPath: this.sessionDecision === undefined ? this.entry?.path : undefined,
    };
  }

  decide(trusted: boolean, remember: boolean): void {
    if (remember) {
      if (this.error) throw new Error(`Trust store is read-only until repaired: ${this.error.message}`);
      this.store.set(this.cwd, trusted);
      this.entry = this.store.getEntry(this.cwd);
      this.sessionDecision = undefined;
      return;
    }
    this.sessionDecision = trusted;
  }
}
