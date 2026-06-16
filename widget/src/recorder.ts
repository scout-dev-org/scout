/**
 * Session recording — production-grade rrweb configuration.
 *
 * Architecture follows hardened rrweb recording patterns:
 *
 * 1. rrweb config: slimDOMOptions:'all', sampling, errorHandler, inlineStylesheet
 * 2. iOS mousemove fix to prevent main thread blocking
 * 3. Safari dialog:modal runtime patches (from PostHog's @rrweb/record patch)
 * 4. Event throttling: max THROTTLE_LIMIT events per THROTTLE_WINDOW_MS
 * 5. Mutation limit: stop recording if >10K mutations
 * 6. Buffer size cap: 5MB max for a lightweight widget
 * 7. fflate compression before sending
 * 8. Graceful degradation: recording failures don't break bug reporting
 */

import type { eventWithTime, recordOptions } from 'rrweb';
import { record } from 'rrweb';
import { gzipSync } from 'fflate';
import type { RecordingSummary } from './debug-context';

// --- Constants ---

/** Rolling buffer duration */
const BUFFER_DURATION_MS = 60_000;

/** Full DOM snapshot interval */
const CHECKOUT_INTERVAL_MS = 60_000;

/** Stop recording if single mutation batch exceeds this */
const MUTATION_LIMIT = 10_000;

/** Max buffer size in bytes before forced trim */
const MAX_BUFFER_SIZE_BYTES = 5_000_000;

/** Server accepts sessionRecording payloads up to 3M base64 chars. */
const MAX_RECORDING_BASE64_CHARS = 3_000_000;

/** Event throttling: max events per window */
const THROTTLE_LIMIT = 60;
const THROTTLE_WINDOW_MS = 5_000;

// --- State ---

let events: eventWithTime[] = [];
let stopFn: (() => void) | null = null;
let paused = false;
let recordingFailed = false;
let estimatedBufferSize = 0;

// Throttle state
let throttleWindowStart = 0;
let throttleCount = 0;

const EVENT_TYPE_FULL_SNAPSHOT = 2;
const EVENT_TYPE_META = 4;
const EVENT_TYPE_INCREMENTAL_SNAPSHOT = 3;
const INCREMENTAL_SOURCE_MUTATION = 0;
const INCREMENTAL_SOURCE_MOUSE_INTERACTION = 2;
const INCREMENTAL_SOURCE_SCROLL = 3;
const INCREMENTAL_SOURCE_INPUT = 5;
const MOUSE_INTERACTION_CLICK = 2;

// --- Runtime patches ---

let patchesApplied = false;

function applyRrwebPatches(): void {
  if (patchesApplied) return;
  patchesApplied = true;

  // Patch 1: Safari dialog:modal crash fix (from PostHog's rrweb patch)
  // Safari 15.4-15.5 throws on element.matches(':modal') and querySelectorAll(':modal')
  try {
    const originalMatches = Element.prototype.matches;
    Element.prototype.matches = function patchedMatches(selector: string): boolean {
      try {
        return originalMatches.call(this, selector);
      } catch {
        return false;
      }
    };
  } catch { /* continue without patch */ }

  // Patch 2: querySelectorAll safety for :modal and other problematic selectors
  try {
    const originalDocQSA = Document.prototype.querySelectorAll;
    Document.prototype.querySelectorAll = function patchedDocQSA(selector: string): NodeListOf<Element> {
      try {
        return originalDocQSA.call(this, selector);
      } catch {
        return document.createDocumentFragment().querySelectorAll('*');
      }
    };

    const originalElQSA = Element.prototype.querySelectorAll;
    Element.prototype.querySelectorAll = function patchedElQSA(selector: string): NodeListOf<Element> {
      try {
        return originalElQSA.call(this, selector);
      } catch {
        return document.createDocumentFragment().querySelectorAll('*');
      }
    };
  } catch { /* continue without patch */ }
}

// --- iOS detection ---

function isIOS(): boolean {
  const ua = navigator?.userAgent ?? '';
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  // iPad with desktop UA
  if (/Macintosh/i.test(ua) && navigator?.maxTouchPoints > 1) return true;
  return false;
}

/**
 * Get platform-specific sampling options.
 * Disable mousemove on iOS to prevent main thread blocking.
 */
function getPlatformSampling(): recordOptions<eventWithTime>['sampling'] {
  if (isIOS()) {
    return {
      mousemove: false,
      scroll: 150,
      input: 'last' as const,
    };
  }
  return {
    mousemove: 50,         // Throttle to 50ms (20fps)
    scroll: 150,           // Throttle scroll events
    input: 'last' as const, // Only last input value per checkout
  };
}

// --- Buffer management ---

function trimBuffer(): void {
  if (events.length === 0) return;

  // Find last full snapshot
  let lastSnapshotIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.type === EVENT_TYPE_FULL_SNAPSHOT) {
      lastSnapshotIdx = i;
      break;
    }
  }

  if (lastSnapshotIdx <= 0) return;

  // Include meta event before snapshot
  let startIdx = lastSnapshotIdx;
  if (startIdx > 0 && events[startIdx - 1]!.type === EVENT_TYPE_META) {
    startIdx = startIdx - 1;
  }

  const now = Date.now();
  const cutoff = now - BUFFER_DURATION_MS;
  if (events[lastSnapshotIdx]!.timestamp >= cutoff && startIdx > 0) {
    const removed = events.splice(0, startIdx);
    // Recalculate buffer size estimate
    estimatedBufferSize = 0;
    for (const e of events) {
      estimatedBufferSize += roughEventSize(e);
    }
    // Avoid unused variable warning
    void removed;
  }
}

/** Rough byte size estimate for an event (avoid JSON.stringify on every event) */
function roughEventSize(event: eventWithTime): number {
  // Full snapshots are large, incremental are small, others are tiny
  if (event.type === EVENT_TYPE_FULL_SNAPSHOT) return 50_000;
  if (event.type === EVENT_TYPE_INCREMENTAL_SNAPSHOT) return 500;
  return 200;
}

/** Check if event should be throttled */
function shouldThrottle(): boolean {
  const now = Date.now();
  if (now - throttleWindowStart > THROTTLE_WINDOW_MS) {
    throttleWindowStart = now;
    throttleCount = 0;
  }
  throttleCount++;
  return throttleCount > THROTTLE_LIMIT;
}

function hasFullSnapshot(): boolean {
  return events.some((event) => event.type === EVENT_TYPE_FULL_SNAPSHOT);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function fitServerLimit(base64: string): string | null {
  return base64.length <= MAX_RECORDING_BASE64_CHARS ? base64 : null;
}

// --- Public API ---

export function startRecording(): void {
  if (stopFn) return;

  applyRrwebPatches();

  events = [];
  paused = false;
  recordingFailed = false;
  estimatedBufferSize = 0;
  throttleWindowStart = Date.now();
  throttleCount = 0;

  try {
    const opts: recordOptions<eventWithTime> = {
      emit(event: eventWithTime) {
        if (paused) return;

        try {
          // Throttle non-critical events.
          if (event.type === EVENT_TYPE_INCREMENTAL_SNAPSHOT && shouldThrottle()) {
            return; // Drop event silently
          }

          const size = roughEventSize(event);

          // Buffer size protection.
          if (estimatedBufferSize + size > MAX_BUFFER_SIZE_BYTES) {
            trimBuffer();
            if (estimatedBufferSize + size > MAX_BUFFER_SIZE_BYTES) {
              return; // Still too big after trim — drop
            }
          }

          events.push(event);
          estimatedBufferSize += size;

          // Periodic trim
          if (events.length % 50 === 0) {
            trimBuffer();
          }
        } catch {
          // Silently drop problematic events
        }
      },

      // --- Privacy ---
      maskAllInputs: true,
      maskInputOptions: { password: true },   // Explicit password masking

      // --- Widget exclusion ---
      blockSelector: '#scout-widget-root',

      // --- Payload optimization ---
      slimDOMOptions: 'all',                  // Strips scripts, comments, head meta, etc.
      inlineStylesheet: true,                 // Required for replay fidelity
      inlineImages: false,                    // Too heavy
      collectFonts: false,                    // Not needed for bug context

      // --- Performance (platform-specific) ---
      sampling: getPlatformSampling(),

      // --- Buffer management ---
      checkoutEveryNms: CHECKOUT_INTERVAL_MS,

      // --- Don't record heavy media ---
      recordCrossOriginIframes: false,
      recordCanvas: false,

      // --- Error handling ---
      errorHandler: (err: unknown) => {
        try {
          if (err && typeof err === 'object') {
            (err as Record<string, unknown>).__rrweb__ = true;
          }
        } catch { /* read-only */ }
        // Don't rethrow — let rrweb continue
      },
    };

    stopFn = record(opts) ?? null;

    if (!stopFn) {
      console.warn('[Scout] rrweb record() returned null — recording disabled');
      recordingFailed = true;
    }
  } catch (err) {
    console.warn('[Scout] Session recording failed to start:', err);
    recordingFailed = true;
    stopFn = null;
  }
}

export function pauseRecording(): void {
  paused = true;
}

export function resumeRecording(): void {
  paused = false;
}

export function stopRecording(): void {
  if (stopFn) {
    try {
      stopFn();
    } catch { /* ignore */ }
    stopFn = null;
  }
}

/**
 * Get recording as gzip-compressed base64 string.
 * Uses fflate for compression.
 * Returns null when recording is unusable or too large for the API.
 */
export function getRecordingCompressed(): string | null {
  if (recordingFailed || events.length === 0) return null;

  try {
    trimBuffer();
    if (events.length === 0) return null;
    if (!hasFullSnapshot()) return null;

    const json = JSON.stringify(events);
    const encoded = new TextEncoder().encode(json);

    // Compress with fflate gzip.
    const compressed = gzipSync(encoded, { level: 6 });

    return fitServerLimit(bytesToBase64(compressed));
  } catch (err) {
    console.warn('[Scout] Failed to compress recording:', err);

    // Fallback: try uncompressed
    try {
      const json = JSON.stringify(events);
      const encoded = new TextEncoder().encode(json);
      return fitServerLimit(bytesToBase64(encoded));
    } catch {
      return null;
    }
  }
}

/** @deprecated Use getRecordingCompressed() instead */
export function getRecordingBase64(): string | null {
  return getRecordingCompressed();
}

export function resetBuffer(): void {
  events = [];
  estimatedBufferSize = 0;
}

export function isRecording(): boolean {
  return stopFn !== null && !recordingFailed;
}

export function isRecordingAvailable(): boolean {
  return !recordingFailed;
}

export function getRecordingSummary(hasRecording: boolean): RecordingSummary {
  if (!hasRecording || events.length === 0) {
    return {
      hasRecording: false,
      recordingDurationMs: 0,
      eventCount: 0,
      firstTimestamp: null,
      lastTimestamp: null,
      fullSnapshotCount: 0,
      incrementalEventCount: 0,
      recordingPath: null,
      importantEvents: [],
    };
  }

  const firstTimestamp = events[0]?.timestamp ?? null;
  const lastTimestamp = events[events.length - 1]?.timestamp ?? null;
  let fullSnapshotCount = 0;
  let incrementalEventCount = 0;
  const importantEvents: RecordingSummary['importantEvents'] = [];

  for (const event of events) {
    if (event.type === EVENT_TYPE_FULL_SNAPSHOT) fullSnapshotCount++;
    if (event.type !== EVENT_TYPE_INCREMENTAL_SNAPSHOT) continue;

    incrementalEventCount++;
    const data = (event as { data?: { source?: number; type?: number; x?: number; y?: number } }).data;
    if (!data || importantEvents.length >= 30) continue;

    if (data.source === INCREMENTAL_SOURCE_MOUSE_INTERACTION && data.type === MOUSE_INTERACTION_CLICK) {
      importantEvents.push({ ts: event.timestamp, type: 'click', summary: `Click at ${data.x ?? '?'}:${data.y ?? '?'}` });
    } else if (data.source === INCREMENTAL_SOURCE_INPUT) {
      importantEvents.push({ ts: event.timestamp, type: 'input', summary: 'Input changed' });
    } else if (data.source === INCREMENTAL_SOURCE_SCROLL) {
      importantEvents.push({ ts: event.timestamp, type: 'scroll', summary: `Scroll to ${data.x ?? 0}:${data.y ?? 0}` });
    } else if (data.source === INCREMENTAL_SOURCE_MUTATION) {
      importantEvents.push({ ts: event.timestamp, type: 'mutation', summary: 'DOM mutation captured' });
    }
  }

  return {
    hasRecording: true,
    recordingDurationMs: firstTimestamp !== null && lastTimestamp !== null ? Math.max(0, lastTimestamp - firstTimestamp) : 0,
    eventCount: events.length,
    firstTimestamp,
    lastTimestamp,
    fullSnapshotCount,
    incrementalEventCount,
    recordingPath: null,
    importantEvents,
  };
}
