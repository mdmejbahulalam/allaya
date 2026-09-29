/**
 * Files that run code when opened. Allaya never *creates* one (a model that can author `.bat` files and drop them
 * on the Desktop can talk the user into running anything) and never *opens* one (opening = executing).
 */
const PROGRAM_EXTENSIONS = new Set([
  'exe',
  'com',
  'scr',
  'pif',
  'bat',
  'cmd',
  'ps1',
  'psm1',
  'psd1',
  'vbs',
  'vbe',
  'js',
  'jse',
  'wsf',
  'wsh',
  'msi',
  'msp',
  'msix',
  'appx',
  'lnk',
  'url',
  'hta',
  'reg',
  'dll',
  'sys',
  'cpl',
  'msc',
  'jar',
  'appref-ms',
  'gadget',
  'application',
  'sh',
]);

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/**
 * True for programs, scripts and shortcuts. Windows treats trailing dots/spaces as absent, so `run.bat.` is also
 * a program; the path policy already rejects such names, but this stays defensive.
 */
export function isProgramFile(name: string): boolean {
  const cleaned = name.replace(/[. ]+$/, '');
  return PROGRAM_EXTENSIONS.has(extensionOf(cleaned));
}
