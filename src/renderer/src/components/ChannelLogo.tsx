import { Music4 } from "lucide-react";
import { useChannelLogo } from "../lib/logo";

interface ChannelLogoProps {
  /** Inline SVG from the API; falls back to the banner when absent. */
  svg?: string | null;
  banner?: string | null;
  alt?: string;
  lazy?: boolean;
  iconSize?: number;
  className?: string;
  /** CSS colour the logo paths are painted in. */
  colour?: string;
}

/**
 * A channel's logo on a dark plate.
 *
 * The site ships every logo as white SVG, so the plate stays dark in both
 * themes and the mark keeps its contrast. The banner is only used when a
 * channel has no logo at all.
 */
export function ChannelLogo({
  svg,
  banner,
  alt = "",
  lazy = false,
  iconSize = 20,
  className = "card__fallback",
  colour = "#ffffff",
}: ChannelLogoProps): JSX.Element {
  const logo = useChannelLogo(svg, colour);
  const src = logo ?? banner ?? null;

  return (
    <>
      <span className={`${className}${logo ? " card__fallback--logo" : ""}`} aria-hidden="true">
        {logo ? null : <Music4 size={iconSize} />}
      </span>
      {src ? (
        <img
          src={src}
          alt={alt}
          className={logo ? "is-logo" : undefined}
          draggable={false}
          {...(lazy ? { loading: "lazy" as const } : null)}
          onError={(e) => {
            // Leave the fallback visible underneath.
            e.currentTarget.style.display = "none";
          }}
        />
      ) : null}
    </>
  );
}
