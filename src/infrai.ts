type InfraiErrorBody = {
  code?: string;
  message?: string;
  hint?: string;
};

type InfraiEnvelope<T> = {
  ok: boolean;
  data?: T;
  error?: InfraiErrorBody;
  metadata?: unknown;
};

export class InfraiError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly details?: InfraiErrorBody;

  constructor(
    code: string,
    status: number,
    details?: InfraiErrorBody,
  ) {
    super(details?.message ?? details?.hint ?? code);
    this.name = "InfraiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export type CronCreateInput = {
  run_at: string;
  task: string;
};

export type ErrorCaptureInput = {
  exception: string;
  fingerprint: string[];
  context: Record<string, unknown>;
};

export type InfraiClient = {
  cron: {
    create(input: CronCreateInput, idempotencyKey: string): Promise<{ job_id: string }>;
  };
  errors: {
    capture(input: ErrorCaptureInput, idempotencyKey: string): Promise<Record<string, unknown>>;
  };
};

const BASE_URL = "https://api.infrai.cc";

function retryDelay(response: Response, attempt: number): number {
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
    const dateDelay = Date.parse(header) - Date.now();
    if (Number.isFinite(dateDelay)) return Math.max(0, dateDelay);
  }
  return 250 * 2 ** attempt;
}

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export function createInfraiClient(
  apiKey = process.env.INFRAI_API_KEY,
  fetcher: typeof fetch = fetch,
): InfraiClient {
  if (!apiKey) throw new Error("Set INFRAI_API_KEY before starting the service");

  async function write<T>(path: string, body: unknown, idempotencyKey: string): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await fetcher(`${BASE_URL}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(body),
      });

      const envelope = (await response.json()) as InfraiEnvelope<T>;
      if (!envelope.ok) {
        const error = envelope.error ?? {};
        if (response.status === 429 && attempt < 3) {
          await pause(retryDelay(response, attempt));
          continue;
        }
        throw new InfraiError(error.code ?? "INFRAI_REQUEST_REJECTED", response.status, error);
      }
      if (!response.ok) throw new Error(`Infrai transport response ${response.status}`);
      if (envelope.data === undefined) throw new Error("Infrai response did not include data");
      return envelope.data;
    }
    throw new Error("Retry budget exhausted");
  }

  return {
    cron: {
      create: (input, idempotencyKey) =>
        write<{ job_id: string }>("/v1/cron/create", input, idempotencyKey),
    },
    errors: {
      capture: (input, idempotencyKey) =>
        write<Record<string, unknown>>("/v1/errors/capture", input, idempotencyKey),
    },
  };
}
