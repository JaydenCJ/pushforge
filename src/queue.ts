/**
 * The delivery queue: one job per (message, subscription), persisted to a
 * JSON file so a crash or reboot loses nothing. Draining is deterministic —
 * the clock and the HTTP transport are both injected — which is what makes
 * retry/backoff behavior unit-testable without a single sleep.
 *
 * Outcome handling follows the push-service contract:
 *   2xx → sent · 404/410 → gone (subscription pruned) · 429/5xx → retried
 *   with exponential backoff · other 4xx → failed permanently.
 */

import { b64urlDecode, b64urlEncode, utf8 } from "./b64url.js";
import { loadJsonFile, saveJsonFile } from "./jsonfile.js";
import { buildPushRequest, classifyStatus } from "./sender.js";
import type { SubscriptionStore } from "./store.js";
import type { MessageOptions, PushSubscription, Transport } from "./types.js";
import type { VapidOptions } from "./vapid.js";

const KIND = "queue";

/** Backoff schedule: 30s · 2m · 8m · 32m, then capped at 1h. Deterministic. */
export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_FACTOR = 4;
export const BACKOFF_CAP_MS = 3_600_000;
export const DEFAULT_MAX_ATTEMPTS = 5;

export type JobStatus = "pending" | "sent" | "gone" | "failed";

export interface QueueJob {
  /** Monotonic per-queue id: "job-1", "job-2", … */
  id: string;
  /** Snapshot of the target subscription (the queue is self-contained). */
  subscription: PushSubscription;
  /** Short id of the subscription, for reporting and pruning. */
  subscriptionId: string;
  /** Payload bytes, base64url. */
  payload: string;
  options: MessageOptions;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  /** Unix ms before which the job must not be attempted. */
  notBefore: number;
  createdAt: number;
  lastStatus?: number;
  lastError?: string;
}

interface QueueData {
  nextId: number;
  jobs: QueueJob[];
}

export interface DrainReport {
  attempted: number;
  sent: number;
  gone: number;
  retried: number;
  failed: number;
  /** Subscription ids whose endpoints the push service declared dead. */
  goneSubscriptionIds: string[];
}

/** Delay before attempt N+1 after N failed attempts. */
export function backoffMs(attempts: number): number {
  const exp = BACKOFF_BASE_MS * BACKOFF_FACTOR ** Math.max(0, attempts - 1);
  return Math.min(exp, BACKOFF_CAP_MS);
}

export interface DrainOptions {
  vapid: VapidOptions;
  transport: Transport;
  /** Clock override, Unix ms. Defaults to Date.now(). */
  now?: number;
  /** When given, subscriptions reported gone are pruned from this store. */
  store?: SubscriptionStore;
}

export class DeliveryQueue {
  readonly path: string;
  private nextId: number;
  private jobs: QueueJob[];

  private constructor(path: string, data: QueueData) {
    this.path = path;
    this.nextId = data.nextId;
    this.jobs = data.jobs;
  }

  /** Open (or lazily create) the queue at `path`. */
  static open(path: string): DeliveryQueue {
    const data = loadJsonFile<QueueData>(path, KIND, { nextId: 1, jobs: [] });
    if (!Array.isArray(data.jobs) || !Number.isInteger(data.nextId) || data.nextId < 1) {
      throw new Error(`${path}: malformed queue data`);
    }
    return new DeliveryQueue(path, data);
  }

  get size(): number {
    return this.jobs.length;
  }

  /** Enqueue one message for many subscriptions: one job each. */
  enqueue(
    payload: Uint8Array | string,
    targets: Array<PushSubscription & { id: string }>,
    options: MessageOptions = {},
    settings: { maxAttempts?: number; now?: number } = {},
  ): QueueJob[] {
    const bytes = typeof payload === "string" ? utf8(payload) : payload;
    if (bytes.length === 0) throw new Error("payload must not be empty");
    const maxAttempts = settings.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error(`invalid maxAttempts ${maxAttempts}: must be a positive integer`);
    }
    const now = settings.now ?? Date.now();
    const encoded = b64urlEncode(bytes);
    const created: QueueJob[] = [];
    for (const target of targets) {
      const job: QueueJob = {
        id: `job-${this.nextId++}`,
        subscription: { endpoint: target.endpoint, keys: target.keys },
        subscriptionId: target.id,
        payload: encoded,
        options: { ...options },
        status: "pending",
        attempts: 0,
        maxAttempts,
        notBefore: now,
        createdAt: now,
      };
      this.jobs.push(job);
      created.push(job);
    }
    return created;
  }

  /** Jobs eligible to run at `now` (pending and past their notBefore). */
  due(now: number = Date.now()): QueueJob[] {
    return this.jobs.filter((job) => job.status === "pending" && job.notBefore <= now);
  }

  /** All jobs, in insertion order. */
  list(status?: JobStatus): QueueJob[] {
    return status === undefined ? [...this.jobs] : this.jobs.filter((job) => job.status === status);
  }

  /** Counters by status. */
  stats(): Record<JobStatus, number> {
    const stats: Record<JobStatus, number> = { pending: 0, sent: 0, gone: 0, failed: 0 };
    for (const job of this.jobs) stats[job.status]++;
    return stats;
  }

  /** Drop finished jobs (sent/gone/failed), keeping pending ones. */
  clearFinished(): number {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((job) => job.status === "pending");
    return before - this.jobs.length;
  }

  /**
   * Attempt every due job once. A transport exception (network down) counts
   * as a retryable attempt, the same as a 5xx — the queue survives offline
   * periods by design.
   */
  async drain(options: DrainOptions): Promise<DrainReport> {
    const now = options.now ?? Date.now();
    const report: DrainReport = { attempted: 0, sent: 0, gone: 0, retried: 0, failed: 0, goneSubscriptionIds: [] };
    for (const job of this.due(now)) {
      report.attempted++;
      job.attempts++;
      let status: number | undefined;
      let error: string | undefined;
      try {
        const request = await buildPushRequest(job.subscription, b64urlDecode(job.payload), {
          ...job.options,
          vapid: { ...options.vapid, now },
        });
        status = (await options.transport(request)).status;
      } catch (err) {
        error = (err as Error).message;
      }
      job.lastStatus = status;
      job.lastError = error;
      const outcome = status === undefined ? "retry" : classifyStatus(status);
      switch (outcome) {
        case "sent":
          job.status = "sent";
          report.sent++;
          break;
        case "gone":
          job.status = "gone";
          report.gone++;
          if (!report.goneSubscriptionIds.includes(job.subscriptionId)) {
            report.goneSubscriptionIds.push(job.subscriptionId);
          }
          if (options.store) options.store.remove(job.subscriptionId);
          break;
        case "failed":
          job.status = "failed";
          report.failed++;
          break;
        case "retry":
          if (job.attempts >= job.maxAttempts) {
            job.status = "failed";
            job.lastError = error ?? `gave up after ${job.attempts} attempt${job.attempts === 1 ? "" : "s"} (last status ${status})`;
            report.failed++;
          } else {
            job.notBefore = now + backoffMs(job.attempts);
            report.retried++;
          }
          break;
      }
    }
    return report;
  }

  /** Persist to disk (atomic write-then-rename). */
  save(): void {
    saveJsonFile<QueueData>(this.path, KIND, { nextId: this.nextId, jobs: this.jobs });
  }
}
