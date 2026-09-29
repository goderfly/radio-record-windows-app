import markSvg from "../../../../resources/record-mark.svg?raw";

/**
 * The Record brand mark, lifted from resources/record-mark.svg.
 *
 * Kept as a component rather than an <img> because it has to inherit the text
 * colour of whatever bar it sits in, the way the site renders it.
 */
export function RecordMark({ className }: { className?: string }): JSX.Element {
  return (
    <span
      className={className}
      aria-hidden="true"
      // Trusted build-time asset from the project's own resources folder.
      dangerouslySetInnerHTML={{ __html: markSvg }}
    />
  );
}
