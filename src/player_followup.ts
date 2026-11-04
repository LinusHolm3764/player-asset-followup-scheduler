import { createHash } from "node:crypto";
import type { InfraiClient } from "./infrai";

export type PlayerAsset = {
  assetId: string;
  playerId: string;
  kind: "map" | "skin" | "quest";
  moderation: "queued" | "approved" | "rejected";
  followUpApplied: boolean;
};

export type LiveEvent = {
  eventId: string;
  name: string;
  endsAt: string;
};

export type FollowUpRequest = {
  asset: PlayerAsset;
  liveEvent: LiveEvent;
  delayHours: number;
  callbackBaseUrl: string;
};

export type ScheduledFollowUp = {
  jobId: string;
  executeAt: string;
  moderationQueue: "priority-review" | "standard-review";
};

export interface AssetStore {
  get(assetId: string): Promise<PlayerAsset | undefined>;
  save(asset: PlayerAsset): Promise<void>;
}

export function chooseModerationQueue(asset: PlayerAsset, event: LiveEvent): ScheduledFollowUp["moderationQueue"] {
  return asset.moderation === "queued" && Date.parse(event.endsAt) > Date.now()
    ? "priority-review"
    : "standard-review";
}

function stableKey(...parts: string[]): string {
  return createHash("sha256").update(parts.join(":"), "utf8").digest("hex");
}

export async function schedulePlayerFollowUp(
  request: FollowUpRequest,
  infrai: InfraiClient,
  now = new Date(),
): Promise<ScheduledFollowUp> {
  const executeAt = new Date(now.getTime() + request.delayHours * 60 * 60 * 1_000);
  const task = new URL(`/callbacks/player-assets/${encodeURIComponent(request.asset.assetId)}`, request.callbackBaseUrl);
  const created = await infrai.cron.create(
    { run_at: executeAt.toISOString(), task: task.toString() },
    stableKey("schedule", request.asset.assetId, executeAt.toISOString()),
  );

  return {
    jobId: created.job_id,
    executeAt: executeAt.toISOString(),
    moderationQueue: chooseModerationQueue(request.asset, request.liveEvent),
  };
}

export async function applyPlayerFollowUp(
  assetId: string,
  store: AssetStore,
  infrai: InfraiClient,
): Promise<"applied" | "already-applied"> {
  try {
    const asset = await store.get(assetId);
    if (!asset) throw new Error(`Player asset ${assetId} was not found`);
    if (asset.followUpApplied) return "already-applied";

    await store.save({ ...asset, followUpApplied: true });
    return "applied";
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    await infrai.errors.capture(
      {
        exception: error.stack ?? error.message,
        fingerprint: ["player-asset-follow-up", assetId],
        context: { assetId, stage: "apply-player-asset-follow-up" },
      },
      stableKey("capture", assetId, "apply-player-asset-follow-up"),
    );
    throw error;
  }
}
