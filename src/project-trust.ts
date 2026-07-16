import {
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
  type ProjectTrustStoreEntry,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { PRODUCT_CONFIG_DIR } from "./product-settings.ts";

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

  hasPiTrustResources(): boolean {
    return hasTrustRequiringProjectResources(this.cwd);
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
