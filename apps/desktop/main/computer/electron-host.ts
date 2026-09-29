import { clipboard, desktopCapturer, screen } from 'electron';
import { AllayaError } from '@allaya/shared';
import type { DisplayInfo, HostServices, ScreenshotResult } from '@allaya/computer';

/**
 * Screenshots, clipboard and display information from Electron itself. These work the same on every platform,
 * so they are the part of computer control that is verified in CI (under Xvfb) rather than only on Windows.
 */
export class ElectronHost implements HostServices {
  async displays(): Promise<DisplayInfo[]> {
    const primary = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d) => ({
      id: d.id,
      // Physical pixels, matching what a screenshot contains and what the input adapter expects.
      bounds: {
        x: Math.round(d.bounds.x * d.scaleFactor),
        y: Math.round(d.bounds.y * d.scaleFactor),
        width: Math.round(d.bounds.width * d.scaleFactor),
        height: Math.round(d.bounds.height * d.scaleFactor),
      },
      scaleFactor: d.scaleFactor,
      primary: d.id === primary,
    }));
  }

  async screenshot(options?: { displayId?: number }): Promise<ScreenshotResult> {
    const displays = screen.getAllDisplays();
    const display =
      options?.displayId !== undefined
        ? displays.find((d) => d.id === options.displayId)
        : screen.getPrimaryDisplay();
    if (!display) throw new AllayaError('There is no such display', { code: 'NOT_FOUND' });
    const width = Math.round(display.size.width * display.scaleFactor);
    const height = Math.round(display.size.height * display.scaleFactor);
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height },
    });
    const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
    if (!source || source.thumbnail.isEmpty()) {
      throw new AllayaError('The screen could not be captured', { code: 'TOOL_EXECUTION_FAILED' });
    }
    const size = source.thumbnail.getSize();
    const png = source.thumbnail.toPNG();
    return {
      bytes: new Uint8Array(png),
      mimeType: 'image/png',
      width: size.width,
      height: size.height,
    };
  }

  async getClipboardText(): Promise<string> {
    return await clipboard.readText();
  }

  async setClipboardText(text: string): Promise<void> {
    await clipboard.writeText(text);
  }
}
