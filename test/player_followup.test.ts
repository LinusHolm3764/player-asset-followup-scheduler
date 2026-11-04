import assert from "node:assert/strict";
import test from "node:test";
import type { InfraiClient } from "../src/infrai";
import { schedulePlayerFollowUp } from "../src/player_followup";

test("a queued live-event asset gets a priority follow-up exactly four hours later", async () => {
  const calls: Array<{ run_at: string; task: string }> = [];
  const fakeInfrai: InfraiClient = {
    cron: {
      async create(input) {
        calls.push(input);
        return { job_id: "job_test_42" };
      },
    },
    errors: { async capture() { return {}; } },
  };

  const result = await schedulePlayerFollowUp(
    {
      asset: {
        assetId: "map_204",
        playerId: "player_7",
        kind: "map",
        moderation: "queued",
        followUpApplied: false,
      },
      liveEvent: {
        eventId: "festival_9",
        name: "Builder Festival",
        endsAt: "2030-06-20T00:00:00.000Z",
      },
      delayHours: 4,
      callbackBaseUrl: "https://game.example.com",
    },
    fakeInfrai,
    new Date("2030-06-10T08:15:37.123Z"),
  );

  assert.deepEqual(result, {
    jobId: "job_test_42",
    executeAt: "2030-06-10T12:15:37.123Z",
    moderationQueue: "priority-review",
  });
  assert.deepEqual(calls, [{
    run_at: "2030-06-10T12:15:37.123Z",
    task: "https://game.example.com/callbacks/player-assets/map_204",
  }]);
});
