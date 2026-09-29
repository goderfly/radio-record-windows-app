import yandexSvg from "../../../../resources/yandex-music.svg?raw";

/**
 * Yandex Music mark, taken from the service's own site (music.yandex.ru).
 *
 * Kept as inline SVG rather than an <img> so it inherits sizing from the CSS
 * and stays crisp without a second request.
 */
export function YandexMusicIcon({ size = 14 }: { size?: number }): JSX.Element {
  return (
    <span
      className="yandex-icon"
      style={{ width: size, height: size }}
      aria-hidden="true"
      // Trusted build-time asset from the project's own resources folder.
      dangerouslySetInnerHTML={{ __html: yandexSvg }}
    />
  );
}
