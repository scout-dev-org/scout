/**
 * Screenshot library, split out of the widget bundle.
 *
 * html2canvas-pro is the single heaviest thing the widget depends on and it is untouched until the
 * reporter has picked an element, so it is built as its own module and fetched at that moment.
 */
export { default as html2canvas } from 'html2canvas-pro';
