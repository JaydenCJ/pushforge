/**
 * The subscription store: a single JSON file you own, instead of a vendor's
 * subscriber database. Subscriptions are validated on the way in, deduplicated
 * by endpoint, addressable by short id or tag, and written atomically.
 */

import { loadJsonFile, saveJsonFile } from "./jsonfile.js";
import { subscriptionId, validateSubscription, validateTag } from "./subscription.js";
import type { PushSubscription, StoredSubscription } from "./types.js";

const KIND = "subscriptions";

interface StoreData {
  subscriptions: StoredSubscription[];
}

export interface AddResult {
  record: StoredSubscription;
  /** false when the endpoint was already present (tags were merged). */
  added: boolean;
}

export class SubscriptionStore {
  readonly path: string;
  private records: Map<string, StoredSubscription>;

  private constructor(path: string, records: StoredSubscription[]) {
    this.path = path;
    this.records = new Map(records.map((record) => [record.id, record]));
  }

  /** Open (or lazily create) the store at `path`. */
  static open(path: string): SubscriptionStore {
    const data = loadJsonFile<StoreData>(path, KIND, { subscriptions: [] });
    if (!Array.isArray(data.subscriptions)) {
      throw new Error(`${path}: subscriptions section is not an array`);
    }
    return new SubscriptionStore(path, data.subscriptions);
  }

  get size(): number {
    return this.records.size;
  }

  /**
   * Validate and insert a subscription. Re-adding an existing endpoint is
   * not an error — tags are merged — because browsers re-post the same
   * subscription freely and the operation must be idempotent.
   */
  async add(value: unknown, tags: string[] = [], now: number = Date.now()): Promise<AddResult> {
    const sub: PushSubscription = validateSubscription(value);
    const cleanTags = [...new Set(tags.map(validateTag))].sort();
    const id = await subscriptionId(sub.endpoint);
    const existing = this.records.get(id);
    if (existing) {
      existing.keys = sub.keys;
      existing.tags = [...new Set([...existing.tags, ...cleanTags])].sort();
      return { record: existing, added: false };
    }
    const record: StoredSubscription = { id, ...sub, tags: cleanTags, createdAt: now };
    this.records.set(id, record);
    return { record, added: true };
  }

  /** Remove by exact id or exact endpoint. Returns whether anything went. */
  remove(idOrEndpoint: string): boolean {
    if (this.records.delete(idOrEndpoint)) return true;
    for (const [id, record] of this.records) {
      if (record.endpoint === idOrEndpoint) {
        this.records.delete(id);
        return true;
      }
    }
    return false;
  }

  /** Look up one subscription by id or endpoint. */
  get(idOrEndpoint: string): StoredSubscription | undefined {
    const byId = this.records.get(idOrEndpoint);
    if (byId) return byId;
    for (const record of this.records.values()) {
      if (record.endpoint === idOrEndpoint) return record;
    }
    return undefined;
  }

  /** List subscriptions, optionally filtered by tag, oldest first. */
  list(tag?: string): StoredSubscription[] {
    const all = [...this.records.values()].sort(
      (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1),
    );
    if (tag === undefined) return all;
    return all.filter((record) => record.tags.includes(tag));
  }

  /**
   * Resolve delivery targets from CLI-ish selectors: explicit ids, a tag,
   * or everything. Throws when a selector matches nothing, because silently
   * sending to zero subscribers hides typos.
   */
  select(options: { ids?: string[]; tag?: string; all?: boolean }): StoredSubscription[] {
    if (options.all) {
      const all = this.list();
      if (all.length === 0) throw new Error("store is empty: nothing to send to");
      return all;
    }
    if (options.tag !== undefined) {
      const tagged = this.list(options.tag);
      if (tagged.length === 0) throw new Error(`no subscriptions tagged ${JSON.stringify(options.tag)}`);
      return tagged;
    }
    if (options.ids && options.ids.length > 0) {
      return options.ids.map((id) => {
        const record = this.get(id);
        if (!record) throw new Error(`no subscription with id ${JSON.stringify(id)}`);
        return record;
      });
    }
    throw new Error("no targets: pass --to <id>, --tag <tag>, or --all");
  }

  /** Persist to disk (atomic write-then-rename). */
  save(): void {
    saveJsonFile<StoreData>(this.path, KIND, { subscriptions: this.list() });
  }
}
