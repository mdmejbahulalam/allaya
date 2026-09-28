import { z } from 'zod';
import { ERROR_CODES } from '@allaya/shared';

export const serializedErrorSchema = z.object({
  code: z.enum(ERROR_CODES),
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});

/** Every IPC invocation resolves to this envelope; handlers never reject across the boundary. */
export type IpcResult<T> =
  { ok: true; data: T } | { ok: false; error: z.infer<typeof serializedErrorSchema> };

/** What the preload sends to main for every invoke. */
export const ipcEnvelopeSchema = z.object({
  channel: z.string().min(1).max(96),
  payload: z.unknown().optional(),
});
export type IpcEnvelope = z.infer<typeof ipcEnvelopeSchema>;

export interface ChannelSpec<Req extends z.ZodType = z.ZodType, Res extends z.ZodType = z.ZodType> {
  request: Req;
  response: Res;
}

export const spec = <Req extends z.ZodType, Res extends z.ZodType>(
  request: Req,
  response: Res,
): ChannelSpec<Req, Res> => ({ request, response });

export const noPayload = z.undefined();
export const idSchema = z.string().min(1).max(128);
export const okSchema = z.object({ ok: z.literal(true) });
