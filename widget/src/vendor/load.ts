/**
 * Loader for the parts of the widget that are not needed to show the button.
 *
 * The recorder and the screenshot library are four fifths of the widget's weight, and a host page
 * pays for them on every visit while almost no visit ever files a report. They are built as separate
 * modules next to this script and fetched from the same origin the widget itself came from.
 */

type ScreenshotVendor = typeof import('./screenshot');
type RecorderVendor = typeof import('./recorder');

let base = '';

export function setVendorBase(apiUrl: string): void {
  base = `${apiUrl.replace(/\/+$/, '')}/widget`;
}

export function loadScreenshotVendor(): Promise<ScreenshotVendor> {
  return import(/* @vite-ignore */ `${base}/scout-screenshot.js`) as Promise<ScreenshotVendor>;
}

export function loadRecorderVendor(): Promise<RecorderVendor> {
  return import(/* @vite-ignore */ `${base}/scout-recorder.js`) as Promise<RecorderVendor>;
}
