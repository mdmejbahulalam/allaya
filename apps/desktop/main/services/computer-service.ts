import type { ComputerEngine, ScreenshotStore } from '@allaya/computer';
import type { ToolDefinition } from '@allaya/tools';
import type { ComputerStatus, SelfTestResult } from '@allaya/validation';
import type { Logger } from '@allaya/shared';
import { toSerializedError } from '@allaya/shared';

export interface ComputerServiceDeps {
  engine: ComputerEngine;
  tools: readonly ToolDefinition[];
  screenshots?: ScreenshotStore & { folder?: string };
  logger: Logger;
}

/** Reports what computer control is available here, and can prove it works. */
export class ComputerService {
  constructor(private readonly deps: ComputerServiceDeps) {}

  status(): ComputerStatus {
    const { engine, tools, screenshots } = this.deps;
    return {
      platform: engine.platform,
      adapter: engine.name,
      capabilities: engine.capabilities(),
      tools: tools.map((tool) => ({
        name: tool.name,
        category: tool.category,
        readOnly: tool.readOnly,
        // A risk function means "depends on the arguments" (e.g. shells are riskier to open than browsers).
        risk: typeof tool.risk === 'function' ? 'varies' : tool.risk,
      })),
      ...(screenshots?.folder ? { screenshotsFolder: screenshots.folder } : {}),
    };
  }

  /**
   * Read-only checks only: it never types, clicks, launches or changes the clipboard. On Windows it is how a
   * person confirms the PowerShell/Win32 integration works on their machine.
   */
  async selfTest(): Promise<SelfTestResult> {
    const { engine, logger } = this.deps;
    const caps = engine.capabilities();
    const steps: SelfTestResult['steps'] = [];
    const step = async (name: string, run: () => Promise<string>) => {
      try {
        steps.push({ name, ok: true, detail: await run() });
      } catch (error) {
        const message = toSerializedError(error).message;
        logger.warn('Computer self-test step failed', { step: name });
        steps.push({ name, ok: false, detail: message });
      }
    };
    steps.push({ name: 'platform', ok: true, detail: `${engine.platform} · ${engine.name}` });
    if (caps.windows) {
      await step('list windows', async () => {
        const windows = await engine.listWindows();
        return `${windows.length} window(s) found`;
      });
    } else {
      steps.push({
        name: 'list windows',
        ok: true,
        skipped: true,
        detail: 'Not available on this operating system',
      });
    }
    if (caps.screenshot) {
      await step('capture screen', async () => {
        const shot = await engine.screenshot();
        return `${shot.width}×${shot.height} pixels`;
      });
    } else {
      steps.push({ name: 'capture screen', ok: true, skipped: true, detail: 'Not available' });
    }
    return { steps, ok: steps.every((s) => s.ok) };
  }
}
