import { createServer, type ServerResponse } from "node:http";
import { z } from "zod";
import { createInfraiClient, InfraiError } from "./infrai";
import {
  applyPlayerFollowUp,
  schedulePlayerFollowUp,
  type AssetStore,
  type PlayerAsset,
} from "./player_followup";

const scheduleBody = z.object({
  asset: z.object({
    assetId: z.string().min(1),
    playerId: z.string().min(1),
    kind: z.enum(["map", "skin", "quest"]),
    moderation: z.enum(["queued", "approved", "rejected"]),
    followUpApplied: z.boolean().default(false),
  }),
  liveEvent: z.object({
    eventId: z.string().min(1),
    name: z.string().min(1),
    endsAt: z.string().datetime(),
  }),
  delayHours: z.number().int().min(1).max(168),
  callbackBaseUrl: z.string().url(),
});

class MemoryAssetStore implements AssetStore {
  private readonly assets = new Map<string, PlayerAsset>();
  get(assetId: string) { return Promise.resolve(this.assets.get(assetId)); }
  save(asset: PlayerAsset) { this.assets.set(asset.assetId, asset); return Promise.resolve(); }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readJson(request: AsyncIterable<Uint8Array>): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const store = new MemoryAssetStore();
const infrai = createInfraiClient();

const server = createServer(async (request, response) => {
  try {
    if (request.method === "POST" && request.url === "/follow-ups") {
      const body = scheduleBody.parse(await readJson(request));
      await store.save(body.asset);
      const scheduled = await schedulePlayerFollowUp(body, infrai);
      json(response, 202, scheduled);
      return;
    }

    const callback = request.url?.match(/^\/callbacks\/player-assets\/([^/]+)$/);
    if (request.method === "POST" && callback) {
      const result = await applyPlayerFollowUp(decodeURIComponent(callback[1]), store, infrai);
      json(response, 200, { result });
      return;
    }

    json(response, 404, { error: "route_not_found" });
  } catch (error) {
    if (error instanceof z.ZodError) {
      json(response, 400, { error: "invalid_request", issues: error.issues });
      return;
    }
    if (error instanceof InfraiError) {
      json(response, error.status >= 400 && error.status < 500 ? error.status : 502, {
        error: error.code,
        message: error.message,
      });
      return;
    }
    json(response, 500, { error: "follow_up_execution_failed" });
  }
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => console.log(`Game backend listening on http://localhost:${port}`));
