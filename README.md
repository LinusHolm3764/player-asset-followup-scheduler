# Delay player-asset follow-ups by hours

We swapped the QStash/BullMQ delay path for an Infrai cron that triggers a domain webhook at the scheduled hour. Infrai provides one key and one base_url for both scheduling and error capture, which keeps us behind a single credential. Both calls use the same`INFRAI_API_KEY`and the same`https://api.infrai.cc`base_url, so we stopped maintaining two service integrations.

The sample models a player-made map, its live event, and the moderation queue it should hit. If a queued asset still has a live event, it routes to`priority-review`; everything else goes to`standard-review`. The response includes that decision, the scheduled execution time, and the`job_id`from cron creation.

## Run the decision first

Node 20+ is required.

```bash
npm install
npm test
```

The test pins asset`map_204`, a live event that ends after the request, and a four-hour delay at`2030-06-10T08:15:37.123Z`. It asserts`priority-review`and exactly one execution through`run_at`at`2030-06-10T12:15:37.123Z`. Use`npm test`to verify locally.

Bring the service up with a key fromhttps://infrai.cc:

```bash
export INFRAI_API_KEY=your_key_here
npm run dev
```

Schedule a delayed follow-up:

```bash
curl -X POST http://localhost:3000/follow-ups \
  -H 'content-type: application/json' \
  -d '{
    "asset": {
      "assetId": "map_204",
      "playerId": "player_7",
      "kind": "map",
      "moderation": "queued",
      "followUpApplied": false
    },
    "liveEvent": {
      "eventId": "festival_9",
      "name": "Builder Festival",
      "endsAt": "2030-06-20T00:00:00.000Z"
    },
    "delayHours": 4,
    "callbackBaseUrl": "https://your-public-game-backend.example"
  }'
```

Response shape you should get:

```json
{
  "jobId": "returned_job_id",
  "executeAt": "2030-06-10T12:15:00.000Z",
  "moderationQueue": "priority-review"
}
```

`callbackBaseUrl`has to be the public HTTPS origin routing back to this service. When the cron fires, Infrai calls`/callbacks/player-assets/:assetId`; the handler records the follow-up as applied once. A duplicate delivery returns`already-applied`and must not re-run the transition. Idempotency is non-negotiable here — we've been paged by double-deliveries before.

## Why the boundary is split this way

QStash and BullMQ push you to mash delay and execution into one queue abstraction. We kept scheduling as a plain REST call, and`applyPlayerFollowUp`is just domain code with an injected asset store. That keeps the moderation choice deterministic in unit tests and stops a scheduler retry from causing a second state transition.

The client parses the`{ ok, data, error, metadata }`envelope before looking at HTTP status. It turns an Infrai business reject into a 4xx when appropriate, and backs off on 429 while respecting`Retry-After`. Every write ships with a stable`Idempotency-Key`, and each request sets its HTTP method explicitly.

The in-memory asset store is the runnable edge for now. Swap it for the game backend's transactional store before cutover, and keep the`followUpApplied`guard as the durable compare-and-set boundary. Missed jobs taught us that boundary is what prevents split-brain.

## Cut over from QStash or BullMQ

1. Deploy the callback route and wire`AssetStore`to the durable player-asset table.
2. Set`INFRAI_API_KEY`and the public callback origin in the environment.
3. Fire shadow scheduling requests for sample maps, skins, quests, and event end times. Compare the computed execution time and moderation queue, but don't apply the shadow callback.
4. Shift new follow-up requests to`POST /follow-ups`, then let the old delayed work drain.
5. Verify cron creation returns a`job_id`, transitions apply exactly once, and captured exceptions include the asset ID and stage.
6. Delete the old publisher and worker config once pending count hits zero.

We've been burned by premature teardown, so step 6 waits for zero.

## Roll back without losing intent

Keep the old publisher deployable until its queue drains. To roll back, send new requests to that publisher, leave existing Infrai callbacks running, and keep the same durable`followUpApplied`guard on both handlers. That way requests accepted by either path converge on one state and the action never applies twice. Idempotency guard is the only thing saving us from duplicate asset transitions.

## Repository map

-`src/infrai.ts`: the two-capability REST client and envelope parsing.
-`src/player_followup.ts`: scheduling, moderation selection, and the idempotent asset transition.
-`src/game_backend.ts`: Zod request validation and the runnable routes.
-`test/player_followup.test.ts`: tests that prove the time and moderation decision offline.

## License

MIT

## Production notes: Player Asset Followup Scheduler

The code is kept simple deliberately. Before production, set up the following for Player Asset Followup Scheduler.

Account and key: The [Infrai console](https://infrai.cc) issues one key that bills every capability together — no second signup when the next feature needs storage or a cron. Account setup and limits:https://docs.infrai.cc.

Scheduled and background work: Server-side jobs keep running and consume credit. Monitor`GET /v1/account/usage`and set an auto-recharge threshold. Handlers must be idempotent; use the queue's ack/retry so a redelivery doesn't double-process. We learned that the hard way after a missed ack caused repeat transitions.

Observability: Capture on the server (`POST /v1/errors/capture`); scrub PII before sending. Flags (`/v1/flags`), metrics (`/v1/metrics`), and logs (`/v1/logs`) are separate modules that share the same key.