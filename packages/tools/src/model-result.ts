import type { ExecutionResult } from './types';

const MAX_OUTPUT_CHARS = 8000;

/** What the model is told when the user or the system stops an action — plain, and it discourages retrying. */
const GUIDANCE: Partial<Record<ExecutionResult['status'], string>> = {
  rejected:
    'The user declined this action. Do not try it again or find a way around it; ask what they would like instead.',
  denied:
    "The user's permission settings do not allow this. Do not try again; tell the user it is turned off.",
  cancelled: 'The action was cancelled before it finished. Do not assume it happened.',
  invalid:
    'The arguments were wrong. Fix them and try once more, or ask the user for what is missing.',
  unknown_tool: 'That tool does not exist. Use only the tools you were given.',
  unsupported: 'That tool is not available on this computer.',
};

/**
 * The text of the tool result given back to the model. It states plainly whether the effect was *verified*, so
 * the model cannot honestly claim success for something that was not confirmed (§131).
 */
export function formatResultForModel(result: ExecutionResult): {
  content: string;
  isError: boolean;
} {
  const body: Record<string, unknown> = {
    ok: result.ok,
    status: result.status,
    ...(result.summary ? { action: result.summary } : {}),
    verification: result.verification,
  };
  if (result.evidence) body['evidence'] = result.evidence;
  if (result.error) body['error'] = result.error.message;
  const guidance = GUIDANCE[result.status];
  if (guidance) body['note'] = guidance;
  if (result.ok && result.verification === 'unverified') {
    body['note'] =
      'The action ran but its effect could NOT be confirmed. Do not tell the user it succeeded; say it was attempted and could not be verified.';
  }
  if (result.output !== undefined) {
    const text = JSON.stringify(result.output) ?? 'null';
    body['output'] =
      text.length > MAX_OUTPUT_CHARS
        ? `${text.slice(0, MAX_OUTPUT_CHARS)}… [truncated ${text.length - MAX_OUTPUT_CHARS} characters]`
        : result.output;
  }
  return { content: JSON.stringify(body), isError: !result.ok };
}
