/**
 * Session recording library, split out of the widget bundle.
 *
 * rrweb and the gzip it feeds are only needed once recording actually starts, which happens after
 * the host page has painted, so they are built as their own module and fetched then.
 */
export { record } from 'rrweb';
export { gzipSync } from 'fflate';
