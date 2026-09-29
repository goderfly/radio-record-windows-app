import { useMemo } from "react";

/**
 * Renders a channel logo.
 *
 * The API sends inline SVG whose paths are `fill="white"`, drawn for a dark
 * plate. Injecting it as markup would put untrusted SVG into the DOM tree, so it
 * is re-encoded as a `data:` URL instead: the browser treats that as an image,
 * no script or external reference can run, and the fill can be recoloured for
 * the active theme before it is handed over.
 */

const cache = new Map<string, string>();

function logoDataUrl(svg: string, colour: string): string {
  const key = `${colour}|${svg}`;
  const hit = cache.get(key);
  if (hit) return hit;

  // `fill="white"` is what the site ships; swap it for the plate colour.
  const painted = svg.replace(/fill="white"/gi, `fill="${colour}"`);
  const url = `data:image/svg+xml,${encodeURIComponent(painted)}`;

  if (cache.size > 400) cache.clear();
  cache.set(key, url);
  return url;
}

export function channelLogo(svg: string | null, colour: string): string | null {
  if (!svg) return null;
  return logoDataUrl(svg, colour);
}

export function useChannelLogo(svg: string | null | undefined, colour: string): string | null {
  return useMemo(() => (svg ? logoDataUrl(svg, colour) : null), [svg, colour]);
}
