import { Music4 } from "lucide-react";

interface CoverProps {
  src: string | null | undefined;
  alt?: string;
  lazy?: boolean;
  iconSize?: number;
  className?: string;
}

/**
 * Cover art with a branded fallback.
 *
 * Renders both layers and lets CSS decide which shows: the fallback sits behind
 * the image, so it appears when there is no `src` or when loading fails.
 */
export function Cover({
  src,
  alt = "",
  lazy = false,
  iconSize = 20,
  className = "card__fallback",
}: CoverProps): JSX.Element {
  return (
    <>
      <span className={className} aria-hidden="true">
        <Music4 size={iconSize} />
      </span>
      {src ? (
        <img
          src={src}
          alt={alt}
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
