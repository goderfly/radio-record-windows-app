import { app, type BrowserWindow } from "electron";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadStations } from "./radiorecord-api";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ContrastRun {
  sel: string;
  text: string;
  ratio: number;
  need: number;
  size: number;
  count: number;
}

interface ContrastAudit {
  total: number;
  failing: number;
  groups: ContrastRun[];
  lowest: ContrastRun | null;
}

/**
 * Walks every visible text run in the current theme and measures it against the
 * nearest opaque backdrop. WCAG AA wants 4.5:1 for body copy and 3:1 once the
 * run counts as large (>=24px, or >=18.66px bold).
 *
 * Results are grouped by component: one line per class beats listing ninety
 * repeats of the same one, and usually a single token fixes a whole group.
 */
async function auditContrast(win: BrowserWindow): Promise<ContrastAudit> {
  return (await win.webContents.executeJavaScript(`(() => {
    const parse = (c) => {
      const m = c.match(/rgba?\\(([^)]+)\\)/);
      if (!m) return null;
      const p = m[1].split(',').map((n) => parseFloat(n));
      return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] };
    };
    const lum = ({ r, g, b }) => {
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const bgOf = (el) => {
      for (let n = el; n; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c && c.a > 0.5) return c;
      }
      return { r: 0, g: 0, b: 0, a: 1 };
    };
    const rows = [];
    for (const el of document.querySelectorAll('body *')) {
      const text = Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent)
        .join('')
        .trim();
      if (!text) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      // Faded and disabled runs are deliberately dim; they are exempt from AA.
      if (Number(cs.opacity) < 0.95) continue;
      if (el.closest('[disabled]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
      const fg = parse(cs.color);
      if (!fg || fg.a < 0.5) continue;
      const bg = bgOf(el);
      const l1 = lum(fg), l2 = lum(bg);
      const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
      const size = parseFloat(cs.fontSize);
      const weight = Number(cs.fontWeight) || 400;
      rows.push({
        sel: (el.className && typeof el.className === 'string' ? el.className.split(' ')[0] : el.tagName),
        text: text.slice(0, 22),
        ratio: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100,
        need: size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5,
        size: Math.round(size),
        count: 1,
      });
    }
    const bySel = new Map();
    for (const r of rows) {
      const prev = bySel.get(r.sel);
      if (!prev || r.ratio < prev.ratio) bySel.set(r.sel, { ...r, count: (prev?.count ?? 0) + 1 });
      else prev.count += 1;
    }
    const groups = [...bySel.values()].sort((a, b) => a.ratio - b.ratio);
    return {
      total: rows.length,
      failing: rows.filter((r) => r.ratio < r.need).length,
      groups: groups.filter((g) => g.ratio < g.need).slice(0, 16),
      lowest: groups[0] || null,
    };
  })()`)) as ContrastAudit;
}

function describeAudit(audit: ContrastAudit): string {
  if (audit.failing === 0) {
    return `${audit.total} runs checked, lowest ${audit.lowest?.ratio}:1 on .${audit.lowest?.sel} ("${audit.lowest?.text}")`;
  }
  return (
    `${audit.failing}/${audit.total} below AA in ${audit.groups.length} groups: ` +
    audit.groups.map((g) => `.${g.sel}×${g.count}=${g.ratio}:1 (need ${g.need}, ${g.size}px)`).join("; ")
  );
}

/**
 * Headless-ish verification run: boots the real window, asserts the UI rendered,
 * pulls live audio bytes through the stream proxy and saves a screenshot.
 * Enabled with RECORD_MINI_SMOKE=<outputDir>.
 */
export async function runSmoke(win: BrowserWindow): Promise<void> {
  const outDir = process.env["RECORD_MINI_SMOKE"]!;
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
  };

  try {
    mkdirSync(outDir, { recursive: true });

    // Surface every renderer-side failure instead of guessing.
    const diagnostics: string[] = [];
    // Electron passes a single details object; older signatures pass positional
    // args. Accept both so this keeps working across versions.
    win.webContents.on("console-message", (...args: unknown[]) => {
      const first = args[0] as { level?: unknown; message?: unknown; sourceId?: unknown; lineNumber?: unknown };
      const level = first?.level ?? args[1];
      const message = first?.message ?? args[2];
      const source = first?.sourceId ?? args[4];
      const line = first?.lineNumber ?? args[3];
      const text = `[renderer:${String(level)}] ${String(message)} (${String(source)}:${String(line)})`;
      diagnostics.push(text);
      console.log(text);
    });
    win.webContents.on("did-fail-load", (_e, code, description, url) => {
      const line = `[did-fail-load] ${code} ${description} ${url}`;
      diagnostics.push(line);
      console.log(line);
    });
    win.webContents.on("preload-error", (_e, preloadPath, error) => {
      const line = `[preload-error] ${preloadPath}: ${error.message}`;
      diagnostics.push(line);
      console.log(line);
    });
    win.webContents.on("render-process-gone", (_e, details) => {
      const line = `[render-process-gone] ${details.reason}`;
      diagnostics.push(line);
      console.log(line);
    });

    // The renderer restores the last station on boot; give it time to settle.
    await sleep(6000);

    const dom = (await win.webContents.executeJavaScript(`(() => ({
      cards: document.querySelectorAll('.card').length,
      genres: document.querySelectorAll('.genre-row').length,
      navItems: document.querySelectorAll('.nav-item').length,
      titlebar: !!document.querySelector('.titlebar'),
      nowbar: !!document.querySelector('.nowbar'),
      status: document.querySelector('.nowbar__signal')?.getAttribute('aria-label')?.trim() ?? '',
      nowTitle: document.querySelector('.nowbar__title')?.textContent?.trim() ?? '',
      nowSub: document.querySelector('.nowbar__sub')?.textContent?.trim() ?? '',
      bodyText: document.body.innerText.slice(0, 400),
    }))()`)) as Record<string, string | number>;

    add("Renderer mounted", Boolean(dom.titlebar && dom.nowbar), `titlebar=${dom.titlebar} nowbar=${dom.nowbar}`);
    add("Station grid populated", Number(dom.cards) > 0, `${dom.cards} cards rendered`);
    add("Genre list populated", Number(dom.genres) > 0, `${dom.genres} genres`);
    add("Sidebar navigation", Number(dom.navItems) >= 4, `${dom.navItems} nav items`);

    // --- brand mark in the title bar ---
    const mark = (await win.webContents.executeJavaScript(`(() => {
      const host = document.querySelector('.titlebar__logo');
      const path = host?.querySelector('svg path');
      if (!host || !path) return null;
      const r = host.getBoundingClientRect();
      const b = path.getBoundingClientRect();
      return {
        w: Math.round(r.width), h: Math.round(r.height),
        pathW: Math.round(b.width), pathH: Math.round(b.height),
        fill: getComputedStyle(path).fill,
      };
    })()`)) as { w: number; h: number; pathW: number; pathH: number; fill: string } | null;

    add(
      "Brand mark drawn in the title bar",
      Boolean(mark && mark.pathW > 8 && mark.pathH > 2 && mark.fill !== "none"),
      mark
        ? `box ${mark.w}x${mark.h}, path ${mark.pathW}x${mark.pathH}, fill ${mark.fill}`
        : "no .titlebar__logo svg path found",
    );

    // Removed chrome must not linger.
    const gone = (await win.webContents.executeJavaScript(`({
      statusPill: !!document.querySelector('.titlebar__status'),
      airLabel: document.querySelector('.nowbar__time')?.textContent?.includes('эфир') ?? false,
    })`)) as { statusPill: boolean; airLabel: boolean };

    add(
      "Removed chrome is gone",
      !gone.statusPill && !gone.airLabel,
      `titlebar status=${gone.statusPill}, "эфир" label in nowbar=${gone.airLabel}`,
    );

    // --- clicking a tile must start that channel ---
    // A real pointer click on the tile body (not the play badge) is the primary
    // interaction, so exercise exactly that and watch the UI react.
    const before = (await win.webContents.executeJavaScript(
      `document.querySelector('.nowbar__title')?.textContent?.trim() ?? ''`,
    )) as string;

    const clickTarget = (await win.webContents.executeJavaScript(`(() => {
      const cards = Array.from(document.querySelectorAll('.card'));
      const card = cards.find((c) => !c.classList.contains('card--active')) ?? cards[0];
      if (!card) return null;
      const r = card.getBoundingClientRect();
      // Click the middle of the artwork, well away from the fav and play badges.
      return {
        title: card.querySelector('.card__title')?.textContent?.trim() ?? '',
        x: r.left + r.width / 2,
        y: r.top + Math.min(r.height * 0.3, 40),
        role: card.getAttribute('role'),
        focusable: card.tabIndex >= 0,
        cursor: getComputedStyle(card).cursor,
      };
    })()`)) as { title: string; x: number; y: number; role: string; focusable: boolean; cursor: string } | null;

    if (clickTarget) {
      add(
        "Tiles are keyboard reachable",
        clickTarget.role === "button" && clickTarget.focusable && clickTarget.cursor === "pointer",
        `role=${clickTarget.role} tabIndex=${clickTarget.focusable} cursor=${clickTarget.cursor}`,
      );

      // Dispatch a genuine click through the renderer.
      await win.webContents.executeJavaScript(`(() => {
        const cards = Array.from(document.querySelectorAll('.card'));
        const card = cards.find((c) => !c.classList.contains('card--active')) ?? cards[0];
        const r = card.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + Math.min(r.height * 0.3, 40);
        const at = document.elementFromPoint(x, y);
        const target = at && card.contains(at) ? at : card;
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
        return true;
      })()`);
      await sleep(4000);

      const after = (await win.webContents.executeJavaScript(`(() => ({
        nowTitle: document.querySelector('.nowbar__title')?.textContent?.trim() ?? '',
        active: document.querySelectorAll('.card--active').length,
        activeTitle: document.querySelector('.card--active .card__title')?.textContent?.trim() ?? '',
      }))()`)) as { nowTitle: string; active: number; activeTitle: string };

      add(
        "Clicking a tile switches channel",
        after.nowTitle.length > 0 && after.nowTitle !== before,
        `"${before}" -> "${after.nowTitle}", ${after.active} active card(s)`,
      );
    }

    // --- a genre chip on a card is a filter toggle ---
    // The chip is a real button, so a genuine pointer click on it must narrow
    // the grid instead of starting the channel. The two failure modes are
    // inverted here on purpose: a missing handler leaves the grid untouched,
    // while a leaked click would both filter and start playing.
    const chipBefore = (await win.webContents.executeJavaScript(`(() => {
      const cards = Array.from(document.querySelectorAll('.card'));
      for (const card of cards) {
        // Skip the playing card: the previous check may have started it, and
        // then "the channel did not change" would be trivially true.
        if (card.classList.contains('card--active')) continue;
        const chip = card.querySelector('.chip--genre');
        if (!chip) continue;
        const r = chip.getBoundingClientRect();
        if (r.bottom < 0 || r.top > innerHeight) continue;
        return {
          genre: chip.textContent.trim(),
          count: cards.length,
          channel: card.querySelector('.card__title')?.textContent?.trim() ?? '',
          playing: document.querySelector('.nowbar__title')?.textContent?.trim() ?? '',
          isButton: chip.tagName === 'BUTTON',
          x: r.left + r.width / 2,
          y: r.top + r.height / 2,
        };
      }
      return null;
    })()`)) as { genre: string; count: number; channel: string; playing: string; isButton: boolean; x: number; y: number } | null;

    if (chipBefore) {
      add(
        "Genre chips on cards are buttons",
        chipBefore.isButton,
        `"${chipBefore.genre}" on "${chipBefore.channel}" is a <${chipBefore.isButton ? "button" : "span"}>`,
      );

      for (const type of ["mouseDown", "mouseUp"] as const) {
        win.webContents.sendInputEvent({ type, x: chipBefore.x, y: chipBefore.y, button: "left", clickCount: 1 });
      }
      await sleep(700);

      const chipAfter = (await win.webContents.executeJavaScript(`(() => ({
        count: document.querySelectorAll('.card').length,
        title: document.querySelector('.toolbar__title')?.textContent?.trim() ?? '',
        subtitle: document.querySelector('.toolbar__subtitle')?.textContent?.trim() ?? '',
        pressed: document.querySelectorAll('.chip--genre.chip--active').length,
        sidebarActive: (document.querySelector('.genre-row--active .genre-row__name')?.textContent || '').trim(),
        nowChannel: document.querySelector('.nowbar__title')?.textContent?.trim() ?? '',
        scrolledTo: document.getElementById('scroller')?.scrollTop ?? -1,
        everyCardHasGenre: Array.from(document.querySelectorAll('.card')).every((c) => c.querySelector('.chip--genre')),
      }))()`)) as {
        count: number;
        title: string;
        subtitle: string;
        pressed: number;
        sidebarActive: string;
        nowChannel: string;
        scrolledTo: number;
        everyCardHasGenre: boolean;
      };

      add(
        "Clicking a genre chip filters the grid",
        chipAfter.count > 0 &&
          chipAfter.count < chipBefore.count &&
          chipAfter.title === chipBefore.genre &&
          chipAfter.sidebarActive === chipBefore.genre &&
          chipAfter.pressed > 0,
        `${chipBefore.count} -> ${chipAfter.count} cards, heading "${chipAfter.title}", sidebar "${chipAfter.sidebarActive}", ${chipAfter.pressed} chip(s) marked pressed`,
      );
      add(
        "Clicking a genre chip does not start the channel",
        chipAfter.nowChannel === chipBefore.playing,
        `nowbar channel "${chipAfter.nowChannel}" — unchanged from "${chipBefore.playing}", not "${chipBefore.channel}"`,
      );

      // The scroller reset rides along with the filter change; the smoke window
      // never animates smooth scrolls, so assert the intent via the count.
      add(
        "Filtering leaves the view within the result list",
        chipAfter.everyCardHasGenre && chipAfter.scrolledTo >= 0,
        `${chipAfter.everyCardHasGenre ? "all" : "not all"} remaining cards carry a genre chip, scroller offset ${chipAfter.scrolledTo}`,
      );

      // Click the same chip again to drop the filter and get the full grid back.
      const clearAt = (await win.webContents.executeJavaScript(`(() => {
        const chip = document.querySelector('.chip--genre.chip--active');
        if (!chip) return null;
        const r = chip.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`)) as { x: number; y: number } | null;

      if (clearAt) {
        for (const type of ["mouseDown", "mouseUp"] as const) {
          win.webContents.sendInputEvent({ type, x: clearAt.x, y: clearAt.y, button: "left", clickCount: 1 });
        }
        await sleep(700);
        const cleared = (await win.webContents.executeJavaScript(`(() => ({
          count: document.querySelectorAll('.card').length,
          title: document.querySelector('.toolbar__title')?.textContent?.trim() ?? '',
          pressed: document.querySelectorAll('.chip--genre.chip--active').length,
        }))()`)) as { count: number; title: string; pressed: number };
        add(
          "Clicking the active genre chip clears the filter",
          cleared.count === chipBefore.count && cleared.title === "Каналы" && cleared.pressed === 0,
          `${cleared.count} cards (was ${chipBefore.count}), heading "${cleared.title}", ${cleared.pressed} pressed`,
        );
      } else {
        add("Clicking the active genre chip clears the filter", false, "the pressed chip was not found");
      }
    } else {
      for (const name of [
        "Genre chips on cards are buttons",
        "Clicking a genre chip filters the grid",
        "Clicking a genre chip does not start the channel",
        "Filtering leaves the view within the result list",
        "Clicking the active genre chip clears the filter",
      ]) {
        add(name, false, "no genre chip inside the viewport");
      }
    }

    // --- channel logos, not banners ---
    const logos = (await win.webContents.executeJavaScript(`(() => {
      const imgs = Array.from(document.querySelectorAll('.card__art img'));
      const logo = imgs.filter((i) => i.classList.contains('is-logo'));
      const banner = imgs.filter((i) => !i.classList.contains('is-logo'));
      const sample = logo[0];
      let decoded = 0;
      for (const i of logo.slice(0, 12)) {
        if (i.complete && i.naturalWidth > 0) decoded += 1;
      }
      return {
        total: imgs.length,
        logos: logo.length,
        banners: banner.length,
        decoded,
        isDataUrl: sample ? sample.src.startsWith('data:image/svg+xml') : false,
        plate: sample ? getComputedStyle(sample).backgroundColor : '',
        fit: sample ? getComputedStyle(sample).objectFit : '',
      };
    })()`)) as {
      total: number; logos: number; banners: number; decoded: number;
      isDataUrl: boolean; plate: string; fit: string;
    };

    add(
      "Cards show channel logos, not banners",
      logos.total > 0 && logos.logos === logos.total && logos.banners === 0,
      `${logos.logos}/${logos.total} logos, ${logos.banners} banners`,
    );
    add(
      "Logos decode as inline SVG",
      logos.decoded >= Math.min(12, logos.logos) && logos.isDataUrl,
      `${logos.decoded} decoded, data-url=${logos.isDataUrl}, fit=${logos.fit}, plate=${logos.plate}`,
    );

    // --- left/right walk the channel's on-air log ---
    const nav = (await win.webContents.executeJavaScript(`(() => ({
      tracks: document.querySelectorAll('.track').length,
      sub: document.querySelector('.nowbar__sub')?.textContent?.trim() ?? '',
      liveDot: !!document.querySelector('.nowbar__sub .dot-live'),
      chip: !!document.querySelector('.live-chip'),
    }))()`)) as { tracks: number; sub: string; liveDot: boolean; chip: boolean };

    if (nav.tracks > 1) {
      const backBtn = (await win.webContents.executeJavaScript(
        `document.querySelector('.transport .icon-btn[aria-label^="Предыдущая"]')?.click() ?? null`,
      )) as null;
      void backBtn;

      await sleep(600);
      const stepped = (await win.webContents.executeJavaScript(`(() => ({
        sub: document.querySelector('.nowbar__sub')?.textContent?.trim() ?? '',
        chip: !!document.querySelector('.live-chip'),
        archiveDot: !!document.querySelector('.nowbar__sub .dot-archive'),
        current: Array.from(document.querySelectorAll('.track--current .track__title'))
          .map((e) => e.textContent?.trim()).join('|'),
      }))()`)) as { sub: string; chip: boolean; archiveDot: boolean; current: string };

      add(
        "Left button steps back through the on-air log",
        stepped.sub.length > 0 && stepped.sub !== nav.sub && stepped.chip,
        `"${nav.sub}" -> "${stepped.sub}", highlighted: ${stepped.current}`,
      );
      add(
        "Browsing past live is marked as archive",
        stepped.archiveDot,
        `archive dot=${stepped.archiveDot}, live dot was ${nav.liveDot}`,
      );

      // Right button must walk back toward live and clear the archive state.
      await win.webContents.executeJavaScript(
        `document.querySelector('.transport .icon-btn[aria-label^="Следующая"]')?.click() ?? null`,
      );
      await sleep(600);
      const returned = (await win.webContents.executeJavaScript(
        `document.querySelector('.nowbar__sub')?.textContent?.trim() ?? ''`,
      )) as string;
      add(
        "Right button returns toward the live track",
        returned === nav.sub,
        `"${stepped.sub}" -> "${returned}"`,
      );
    } else {
      add(
        "Left button steps back through the on-air log",
        false,
        `only ${nav.tracks} track(s) in the channel log`,
      );
    }

    // --- clicking a log row must load that track ---
    // Uses a real native mouse event at the row's coordinates rather than a
    // synthetic click: only that exercises the whole path (hit testing, the
    // renderer event bridge, React) and would catch a transparent overlay that
    // a direct .click() would sail straight through.
    if (nav.tracks > 2) {
      // Scroll instantly. The stylesheet sets `scroll-behavior: smooth`, and that
      // animates scrollTop assignments too — a smooth animation never advances in
      // a window the compositor treats as occluded, so the row would stay
      // off-screen. Turning the behaviour off for the duration is a test-only
      // concession; in a real window the smooth scroll works fine.
      const scrolled = (await win.webContents.executeJavaScript(`(() => {
        const box = document.querySelector('.app__content');
        const row = document.querySelectorAll('.track')[2];
        if (!box || !row) return null;
        const before = { scrollTop: box.scrollTop, scrollHeight: box.scrollHeight, clientHeight: box.clientHeight };
        const inline = box.style.scrollBehavior;
        box.style.scrollBehavior = 'auto';
        const rowBox = row.getBoundingClientRect();
        const boxBox = box.getBoundingClientRect();
        box.scrollTop = rowBox.top - boxBox.top + box.scrollTop - box.clientHeight / 2;
        const after = box.scrollTop;
        box.style.scrollBehavior = inline;
        return { before, after, scrollable: box.scrollHeight > box.clientHeight };
      })()`)) as { before: { scrollTop: number; scrollHeight: number; clientHeight: number }; after: number; scrollable: boolean } | null;

      add(
        "The channel log can be scrolled to",
        Boolean(scrolled?.scrollable && scrolled.after > 0),
        scrolled
          ? `content ${scrolled.before.scrollHeight}px tall in ${scrolled.before.clientHeight}px viewport, scrolled to ${Math.round(scrolled.after)}`
          : "no .app__content or no third row",
      );
      await sleep(400);

      const rowClick = (await win.webContents.executeJavaScript(`(() => {
        const rows = Array.from(document.querySelectorAll('.track'));
        const row = rows[2];
        if (!row) return { ok: false, why: 'no row 2' };
        const r = row.getBoundingClientRect();
        const x = Math.round(r.left + Math.min(r.width * 0.4, 200));
        const y = Math.round(r.top + r.height / 2);
        const at = document.elementFromPoint(x, y);
        return {
          ok: true,
          x, y,
          inViewport: x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight,
          hit: at ? (at.className || at.tagName).toString().slice(0, 48) : 'null',
          inside: !!at && row.contains(at),
          wanted: (row.querySelector('.track__title')?.textContent || '').trim(),
        };
      })()`)) as { ok: boolean; why?: string; x?: number; y?: number; inViewport?: boolean; hit?: string; inside?: boolean; wanted?: string };

      add(
        "History row is reachable by the mouse",
        Boolean(rowClick.ok && rowClick.inViewport && rowClick.inside),
        rowClick.ok
          ? `at (${rowClick.x},${rowClick.y}) hits .${rowClick.hit}, in viewport: ${rowClick.inViewport}`
          : String(rowClick.why),
      );

      if (rowClick.ok && rowClick.inViewport) {
        for (const type of ["mouseDown", "mouseUp"] as const) {
          win.webContents.sendInputEvent({
            type,
            x: rowClick.x!,
            y: rowClick.y!,
            button: "left",
            clickCount: 1,
          });
        }
        await sleep(500);

        const jumped = (await win.webContents.executeJavaScript(`(() => {
          const rows = Array.from(document.querySelectorAll('.track'));
          return {
            sub: document.querySelector('.nowbar__sub')?.textContent?.trim() ?? '',
            currentIndex: rows.findIndex((r) => r.classList.contains('track--current')),
            currentTitle: (rows.find((r) => r.classList.contains('track--current'))?.querySelector('.track__title')?.textContent || '').trim(),
            chip: !!document.querySelector('.live-chip'),
          };
        })()`)) as { sub: string; currentIndex: number; currentTitle: string; chip: boolean };

        add(
          "Clicking a log row loads that track",
          jumped.currentIndex === 2 && jumped.currentTitle === rowClick.wanted && jumped.sub.length > 0,
          `row 2 "${rowClick.wanted}" -> highlighted row ${jumped.currentIndex} "${jumped.currentTitle}", nowbar "${jumped.sub}"`,
        );
      } else {
        add("Clicking a log row loads that track", false, "row was not on screen to click");
      }

      // Put the grid back in view: the checks that follow sample the grid gap and
      // cover art, which are off-screen once the log has been scrolled to.
      await win.webContents.executeJavaScript(
        `document.querySelector('.app__content')?.scrollTo({ top: 0, behavior: 'instant' }); true`,
      );
      await sleep(500);

      // --- the store link must be Yandex Music, not iTunes ---
      const yandex = (await win.webContents.executeJavaScript(`(() => {
        const row = document.querySelectorAll('.track')[1];
        const btn = row?.querySelector('[aria-label*="Яндекс"]');
        const svg = btn?.querySelector('.yandex-icon svg');
        const path = svg?.querySelector('path[fill]');
        return {
          exists: !!btn,
          apple: !!row?.querySelector('[aria-label*="Apple"]'),
          label: btn?.getAttribute('aria-label') ?? '',
          plate: svg?.querySelector('rect')?.getAttribute('fill') ?? null,
          glyph: path?.getAttribute('fill') ?? null,
          size: btn ? Math.round(btn.querySelector('.yandex-icon')?.getBoundingClientRect().width ?? 0) : 0,
        };
      })()`)) as { exists: boolean; apple: boolean; label: string; plate: string | null; glyph: string | null; size: number };

      add(
        "Log rows link out to Yandex Music",
        yandex.exists && !yandex.apple && yandex.glyph?.toLowerCase() === "#ffee00" && yandex.size >= 12,
        `label "${yandex.label}", plate ${yandex.plate}, glyph ${yandex.glyph}, ${yandex.size}px, any Apple link: ${yandex.apple}`,
      );

      // --- the same row must work in the dedicated history view ---
      const goView = async (label: string) => {
        const script = `(() => {
          const btn = Array.from(document.querySelectorAll('.nav-item'))
            .find((b) => (b.textContent || '').includes(${JSON.stringify(label)}));
          if (!btn) return null;
          const r = btn.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        })()`;
        const hit = (await win.webContents.executeJavaScript(script)) as { x: number; y: number } | null;
        if (!hit) return false;
        for (const type of ["mouseDown", "mouseUp"] as const) {
          win.webContents.sendInputEvent({ type, x: hit.x, y: hit.y, button: "left", clickCount: 1 });
        }
        await sleep(700);
        return true;
      };

      if (await goView("История эфира")) {
        const inHistoryView = (await win.webContents.executeJavaScript(`(() => {
          const active = document.querySelector('.nav-item--active .nav-item__label');
          const heading = document.querySelector('.panel__title');
          return {
            active: active ? active.textContent.trim() : '',
            rows: document.querySelectorAll('.track').length,
            heading: heading ? heading.textContent.trim() : '',
          };
        })()`)) as { active: string; rows: number; heading: string };

        add(
          "Sidebar opens the history view",
          inHistoryView.active === "История эфира" && inHistoryView.rows > 1,
          `active="${inHistoryView.active}", ${inHistoryView.rows} rows, heading "${inHistoryView.heading}"`,
        );

        // Click row 4 here; in this view the log is at the top so no scroll is
        // needed, which isolates the row handler from any scrolling behaviour.
        const spot = (await win.webContents.executeJavaScript(`(() => {
          const row = document.querySelectorAll('.track')[4];
          if (!row) return null;
          const r = row.getBoundingClientRect();
          const x = Math.round(r.left + Math.min(r.width * 0.4, 200));
          const y = Math.round(r.top + r.height / 2);
          return {
            x, y,
            wanted: (row.querySelector('.track__title')?.textContent || '').trim(),
            visible: y > 0 && y < innerHeight,
          };
        })()`)) as { x: number; y: number; wanted: string; visible: boolean } | null;

        if (spot?.visible) {
          for (const type of ["mouseDown", "mouseUp"] as const) {
            win.webContents.sendInputEvent({ type, x: spot.x, y: spot.y, button: "left", clickCount: 1 });
          }
          await sleep(500);
          const jumped2 = (await win.webContents.executeJavaScript(`(() => {
            const rows = Array.from(document.querySelectorAll('.track'));
            return {
              currentIndex: rows.findIndex((r) => r.classList.contains('track--current')),
              currentTitle: (rows.find((r) => r.classList.contains('track--current'))?.querySelector('.track__title')?.textContent || '').trim(),
              sub: document.querySelector('.nowbar__sub')?.textContent?.trim() ?? '',
            };
          })()`)) as { currentIndex: number; currentTitle: string; sub: string };

          add(
            "Clicking a row in the history view loads that track",
            jumped2.currentIndex === 4 && jumped2.currentTitle === spot.wanted,
            `row 4 "${spot.wanted}" -> highlighted row ${jumped2.currentIndex} "${jumped2.currentTitle}"`,
          );
        } else {
          add("Clicking a row in the history view loads that track", false, "row 4 was not on screen");
        }

        // The panel header doubles as a "show as its own section" toggle.
        await win.webContents.executeJavaScript(
          `Array.from(document.querySelectorAll('.panel__head .btn'))
             .find((b) => (b.textContent || '').includes('Скрыть'))?.click(); true`,
        );
        await sleep(600);
        const backHome = (await win.webContents.executeJavaScript(
          `(document.querySelector('.nav-item--active .nav-item__label')?.textContent || '').trim()`,
        )) as string;
        add(
          "History section toggle returns to the grid",
          backHome === "Каналы",
          `active view is now "${backHome}"`,
        );
      } else {
        add("Sidebar opens the history view", false, "no sidebar item for История эфира");
        add("Clicking a row in the history view loads that track", false, "could not open the view");
        add("History section toggle returns to the grid", false, "could not open the view");
      }

      await win.webContents.executeJavaScript(
        `document.querySelector('.app__content')?.scrollTo({ top: 0, behavior: 'instant' }); true`,
      );
      await sleep(400);
    } else {
      add("History row is reachable by the mouse", false, `only ${nav.tracks} rows`);
      add("Clicking a log row loads that track", false, `only ${nav.tracks} rows`);
    }

    // --- layout geometry ---
    // Park the cursor first: the clicks above leave a tile under the pointer, and
    // :hover lifts a card by 2px, which would skew any measurement taken after.
    win.webContents.sendInputEvent({ type: "mouseMove", x: 4, y: 4 });
    await sleep(200);
    // The screenshot cannot be inspected automatically, so assert the boxes are
    // real and sane: nothing collapsed to zero, nothing clipped by the viewport.
    const layout = (await win.webContents.executeJavaScript(`(() => {
      const box = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      };
      const cards = Array.from(document.querySelectorAll('.card'));
      // Measure layout, not paint: .card:hover lifts a tile by 2px, and a
      // transform would otherwise split one grid row into two in this probe.
      const top = (c) => c.offsetTop;
      const left = (c) => c.offsetLeft;
      const first = cards[0];
      const second = cards[1];
      const rows = new Set(cards.map(top)).size;
      const cols = new Set(cards.filter((c) => top(c) === top(first)).map(left)).size;
      const overflowing = Array.from(document.querySelectorAll('body *')).filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.right > window.innerWidth + 1;
      }).slice(0, 4).map((el) => (el.className || el.tagName).toString().slice(0, 40));
      return {
        vw: window.innerWidth, vh: window.innerHeight,
        titlebar: box('.titlebar'), sidebar: box('.sidebar'), main: box('.main'),
        nowbar: box('.nowbar'),
        cardCount: cards.length,
        cardW: first ? Math.round(first.getBoundingClientRect().width) : 0,
        cardH: first ? Math.round(first.getBoundingClientRect().height) : 0,
        sameRow: !!first && !!second && top(first) === top(second),
        firstY: first ? top(first) : null,
        secondY: second ? top(second) : null,
        firstCols: cols,
        rows,
        docOverflowX: document.documentElement.scrollWidth - window.innerWidth,
        overflowing,
        hidden: Array.from(document.querySelectorAll('.card, .nowbar, .titlebar'))
          .filter((el) => getComputedStyle(el).visibility === 'hidden' || getComputedStyle(el).opacity === '0').length,
      };
    })()`)) as Record<string, unknown>;

    add(
      "Layout fills the window",
      Number(layout["cardW"]) > 120 && Number(layout["cardH"]) > 100 && Number(layout["docOverflowX"]) <= 0,
      `card ${layout["cardW"]}x${layout["cardH"]}, titlebar ${JSON.stringify(layout["titlebar"])}, overflowX=${layout["docOverflowX"]}`,
    );
    add(
      "Station grid is a grid",
      Boolean(layout["sameRow"]) && Number(layout["rows"]) > 1 && Number(layout["firstCols"]) > 1,
      `${layout["cardCount"]} cards, ${layout["rows"]} rows, ${layout["firstCols"]} per row, first row at y=${layout["firstY"]}`,
    );
    add(
      "No elements clipped past the viewport",
      Array.isArray(layout["overflowing"]) && (layout["overflowing"] as unknown[]).length === 0,
      (layout["overflowing"] as string[]).join(", ") || "none",
    );
    add(
      "Panels visible",
      Number(layout["hidden"]) === 0 &&
        Number((layout["titlebar"] as { h?: number })?.h ?? 0) > 24 &&
        Number((layout["nowbar"] as { h?: number })?.h ?? 0) > 40 &&
        Number((layout["sidebar"] as { w?: number })?.w ?? 0) > 100,
      `titlebar h=${(layout["titlebar"] as { h?: number })?.h}, sidebar w=${(layout["sidebar"] as { w?: number })?.w}, nowbar h=${(layout["nowbar"] as { h?: number })?.h}, hidden=${layout["hidden"]}`,
    );

    // Catalog comes from the bundled snapshot.
    const stations = await loadStations();
    // --- art, contrast, text ---
    // These stand in for a human looking at the screenshot: covers resolved,
    // body text readable against its background, and nothing truncated to
    // ellipsis where it should wrap.
    const visuals = (await win.webContents.executeJavaScript(`(() => {
      const parse = (c) => {
        const m = c.match(/rgba?\\(([^)]+)\\)/);
        if (!m) return null;
        const p = m[1].split(',').map((n) => parseFloat(n));
        return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] };
      };
      const lum = ({ r, g, b }) => {
        const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const bgOf = (el) => {
        for (let n = el; n; n = n.parentElement) {
          const c = parse(getComputedStyle(n).backgroundColor);
          if (c && c.a > 0.5) return c;
        }
        return { r: 0, g: 0, b: 0, a: 1 };
      };
      const ratio = (el) => {
        const fg = parse(getComputedStyle(el).color);
        const bg = bgOf(el);
        if (!fg) return null;
        const l1 = lum(fg), l2 = lum(bg);
        const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
        return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
      };
      const lowest = (sel) => {
        const els = Array.from(document.querySelectorAll(sel)).slice(0, 40);
        let worst = 99, name = '';
        for (const el of els) {
          if (!el.textContent?.trim()) continue;
          const r = ratio(el);
          if (r !== null && r < worst) { worst = r; name = (el.className || el.tagName).toString().split(' ')[0]; }
        }
        return { worst: worst === 99 ? null : worst, name, count: els.length };
      };
      // Covers are loading="lazy", so only judge the ones actually on screen.
      const imgs = Array.from(document.querySelectorAll('img'));
      const onScreen = imgs.filter((i) => {
        const r = i.getBoundingClientRect();
        return r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
      });
      const withArt = onScreen.filter((i) => i.complete && i.naturalWidth > 0);
      // The fallback must be painted *behind* the image, otherwise it hides
      // every cover behind a flat brand-coloured block.
      const hiddenByFallback = withArt.filter((i) => {
        const fb = i.parentElement?.querySelector('.card__fallback');
        if (!fb) return false;
        const ir = i.getBoundingClientRect();
        const fr = fb.getBoundingClientRect();
        const overlap = ir.left < fr.right && ir.right > fr.left && ir.top < fr.bottom && ir.bottom > fr.top;
        return overlap && Number(getComputedStyle(fb).zIndex) >= Number(getComputedStyle(i).zIndex);
      }).length;
      return {
        imgs: imgs.length,
        onScreen: onScreen.length,
        artLoaded: withArt.length,
        artRatio: onScreen.length ? Math.round((withArt.length / onScreen.length) * 100) : 0,
        hiddenByFallback,
        navText: lowest('.nav-item'),
        cardTitle: lowest('.card__title'),
        cardMeta: lowest('.card__desc'),
        nowTitle: lowest('.nowbar__title'),
        nowSub: lowest('.nowbar__sub'),
        truncated: Array.from(document.querySelectorAll('.card__title, .nowbar__title, .nowbar__sub'))
          .filter((el) => el.scrollWidth > el.clientWidth + 1).length,
      };
    })()`)) as Record<string, { worst?: number | null; name?: string; count?: number }>;

    const contrastOk = (c: { worst?: number | null }, min: number) =>
      c.worst !== null && c.worst !== undefined && c.worst >= min;

    add(
      "Cover art loads",
      Number(visuals["artRatio"]) >= 80,
      `${visuals["artLoaded"]}/${visuals["onScreen"]} visible covers decoded of ${visuals["imgs"]} in DOM (${visuals["artRatio"]}%)`,
    );
    add(
      "Covers are not hidden behind the fallback",
      Number(visuals["hiddenByFallback"]) === 0,
      `${visuals["hiddenByFallback"]} covers overlapped by a higher-stacked fallback`,
    );
    add(
      "Text contrast is readable",
      contrastOk(visuals["navText"], 4.5) &&
        contrastOk(visuals["cardTitle"], 4.5) &&
        contrastOk(visuals["cardMeta"], 3),
      `nav ${visuals["navText"].worst}:1 (.${visuals["navText"].name}), card title ${visuals["cardTitle"].worst}:1, card meta ${visuals["cardMeta"].worst}:1, nowbar ${visuals["nowTitle"].worst}:1`,
    );

    // Full sweep of every visible text run, so a dim corner of the UI cannot
    // hide behind the spot checks above.
    const audit = await auditContrast(win);
    add("Every visible text run meets WCAG AA (dark)", audit.failing === 0, describeAudit(audit));

    // The sort switch ("По алфавиту" / "По жанру") was the dimmest thing in the
    // app, so assert its steps explicitly rather than trusting that the sweep
    // happens to walk it: the idle label must be legible, the selected one
    // clearly brighter still, and the track recessed behind the page.
    const sort = (await win.webContents.executeJavaScript(`(() => {
      const chan = (c) => {
        const m = c.match(/rgba?\\(([^)]+)\\)/);
        if (!m) return null;
        const p = m[1].split(',').map((n) => parseFloat(n));
        const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(p[0]) + 0.7152 * f(p[1]) + 0.0722 * f(p[2]);
      };
      // The scroll box itself is transparent; the page colour is the first
      // opaque backdrop above it.
      const page = (() => {
        for (let n = document.querySelector('.app__content'); n; n = n.parentElement) {
          const m = getComputedStyle(n).backgroundColor.match(/rgba?\\(([^)]+)\\)/);
          if (m && parseFloat(m[1].split(',')[3] ?? '1') > 0.5) return chan(getComputedStyle(n).backgroundColor) || 0;
        }
        return 0;
      })();
      const box = document.querySelector('.segmented');
      const off = box && box.querySelector('button[aria-pressed="false"]');
      const on = box && box.querySelector('button[aria-pressed="true"]');
      return {
        labels: off ? off.textContent.trim() + ' / ' + on.textContent.trim() : 'none',
        off: off ? chan(getComputedStyle(off).color) : 0,
        on: on ? chan(getComputedStyle(on).color) : 0,
        track: box ? chan(getComputedStyle(box).backgroundColor) : 0,
        app: page,
      };
    })()`)) as { labels: string; off: number; on: number; track: number; app: number };

    add(
      "Sort switch is legible in the dark theme",
      // 0.30 luminance is roughly where the old #7a7a7a used to sit (0.19).
      sort.off >= 0.3 && sort.on > sort.off * 1.8 && sort.track < sort.app,
      `"${sort.labels}": idle ${sort.off.toFixed(3)}, selected ${sort.on.toFixed(3)}, track ${sort.track.toFixed(3)} vs page ${sort.app.toFixed(3)}`,
    );

    add(
      "Text is not clipped",
      Number(visuals["truncated"]) === 0,
      `${visuals["truncated"]} horizontally truncated elements`,
    );

    add("Catalog loaded", stations.length > 100, `${stations.length} stations`);
    add(
      "Every station has streams",
      stations.every((s) => s.sources.length > 0),
      `min sources = ${Math.min(...stations.map((s) => s.sources.length))}`,
    );

    // --- the important one: does audio actually flow through the proxy? ---
    const station = stations.find((s) => s.prefix === "record") ?? stations[0];

    const proxyUrl = (
      await win.webContents.executeJavaScript(
        `window.recordMini.player.streamUrl(${JSON.stringify(station.prefix)}, 96)`,
      )
    ) as string;

    let bytes = 0;
    let firstByteMs = 0;
    const started = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      const res = await fetch(proxyUrl, { signal: controller.signal });
      const contentType = res.headers.get("content-type") ?? "";
      const reader = res.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (bytes === 0 && value) firstByteMs = Date.now() - started;
          bytes += value.byteLength;
          if (bytes > 256 * 1024) break;
        }
      }
      clearTimeout(timer);
      reader?.cancel().catch(() => {});
      add(
        "Stream proxy serves AAC",
        bytes > 64 * 1024 && contentType.includes("audio/aac"),
        `${bytes} bytes, content-type=${contentType}, first byte after ${firstByteMs}ms`,
      );
    } catch (err) {
      add("Stream proxy serves AAC", false, `error: ${String(err)}`);
    }

    // Now-playing metadata from the public history endpoint.
    let historyItems = 0;
    try {
      const history = (await win.webContents.executeJavaScript(
        `window.recordMini.onAir.history(${station.id})`,
      )) as Array<unknown>;
      historyItems = history.length;
      add("On-air history available", historyItems > 0, `${historyItems} tracks`);
    } catch (err) {
      add("On-air history available", false, `error: ${String(err)}`);
    }

    add("Playback state reported", String(dom.status).length > 0, `signal = "${dom.status}"`);
    add("Now playing shows a track", String(dom.nowSub).length > 0, `"${dom.nowTitle}" / "${dom.nowSub}"`);

    // Screenshot for a visual check. capturePage can return an empty buffer when
    // the window is occluded, so make it visible and retry once.
    const capture = async (): Promise<Buffer> => {
      // Chromium stops producing frames when the window is occluded or
      // background-throttled, and capturePage then returns an empty image.
      win.webContents.setBackgroundThrottling(false);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (win.isMinimized()) win.restore();
        if (!win.isVisible()) win.show();
        win.setAlwaysOnTop(true);
        await sleep(500);
        const png = (await win.webContents.capturePage()).toPNG();
        if (png.length > 10_000) {
          win.setAlwaysOnTop(false);
          return png;
        }
        console.log(`capture attempt ${attempt + 1} returned ${png.length} bytes, retrying`);
      }
      win.setAlwaysOnTop(false);
      return Buffer.alloc(0);
    };

    const png = await capture();
    const shot = join(outDir, "smoke.png");
    writeFileSync(shot, png);
    add("Screenshot captured", png.length > 10000, `${shot} (${(png.length / 1024).toFixed(0)} KB)`);

    // Sample the real painted pixels at the centre of every visible cover.
    // If the fallback were still on top, these would all be one flat brand
    // colour instead of varied artwork.
    const artCentres = (await win.webContents.executeJavaScript(`(() => {
      return Array.from(document.querySelectorAll('.card__art'))
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.bottom > 0 && r.top < window.innerHeight)
        .slice(0, 24)
        .map((r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 }));
    })()`)) as Array<{ x: number; y: number }>;

    // Content size in CSS px; capturePage returns device px on HiDPI displays.
    const [cssW, cssH] = win.getContentSize();
    const darkFrame = await win.webContents.capturePage();
    const size = darkFrame.getSize();
    const bitmap = darkFrame.toBitmap();

    // Cross-check the DOM against the real painted pixels. An absolutely
    // positioned layer that escapes its container (missing `position: relative`
    // on the parent) repaints the whole shell, and the DOM keeps reporting the
    // intended background, so only this catches it.
    //
    // Probe points are derived from the live layout so they stay on bare shell
    // whatever the window size or column count.
    const probePoints = (await win.webContents.executeJavaScript(`(() => {
      const out = [];
      const top = (x, y) => {
        const h = document.elementFromPoint(x, y);
        return h ? ((typeof h.className === 'string' ? h.className : h.tagName).split(' ')[0]) : 'none';
      };
      const at = (label, el, fx, fy) => {
        if (!el) return;
        const r = el.getBoundingClientRect();
        const x = Math.round(r.left + r.width * fx);
        const y = Math.round(r.top + r.height * fy);
        out.push({ label, x, y, top: top(x, y) });
      };
      // A point inside the first card's art box is content, not shell.
      at('card art', document.querySelector('.card__art'), 0.5, 0.5);
      // Midway between the first two cards of the top row: bare grid gap.
      const cards = document.querySelectorAll('.card');
      if (cards[0] && cards[1]) {
        const a = cards[0].getBoundingClientRect();
        const b = cards[1].getBoundingClientRect();
        const x = Math.round((a.right + b.left) / 2);
        const y = Math.round(a.top + a.height / 2);
        out.push({ label: 'grid gap', x, y, top: top(x, y) });
      }
      at('sidebar', document.querySelector('.sidebar'), 0.5, 0.8);
      at('titlebar', document.querySelector('.titlebar'), 0.5, 0.5);
      return out;
    })()`)) as Array<{ label: string; x: number; y: number; top: string }>;

    // Leaf decorations legitimately sit on top of the card art probe; the shell
    // probes must land on their own container.
    const SHELL_POINTS = new Set(["grid gap", "sidebar", "titlebar"]);
    const SHELL_ALLOWED =
      /^(sidebar|main|content|station-grid|grid|app|titlebar|body|empty|nowbar|genre|history|track-list|track|footer|header|section|div|aside|ul|nav)/i;
    const escaped = probePoints.filter((p) => SHELL_POINTS.has(p.label) && !SHELL_ALLOWED.test(p.top));

    const mismatches: string[] = [];
    for (const pt of probePoints) {
      const px = Math.round((pt.x / cssW) * size.width);
      const py = Math.round((pt.y / cssH) * size.height);
      if (px < 0 || py < 0 || px >= size.width || py >= size.height) continue;
      const i = (py * size.width + px) * 4;
      const [r, g, b] = [bitmap[i], bitmap[i + 1], bitmap[i + 2]];
      // The shell is neutral dark, never brand orange.
      if (r > 170 && g > 50 && g < 180 && b < 100) {
        mismatches.push(`${pt.label} top=${pt.top} rgb(${r},${g},${b})`);
      }
    }
    add(
      "No layers escape their container",
      escaped.length === 0 && mismatches.length === 0,
      escaped.length === 0 && mismatches.length === 0
        ? probePoints.map((p) => `${p.label}=${p.top}`).join(", ")
        : [...escaped.map((p) => `${p.label} covered by ${p.top}`), ...mismatches].join("; "),
    );

    if (artCentres.length && png.length > 0) {
      const seen = new Map<string, number>();
      for (const c of artCentres) {
        // capturePage returns device pixels, which differ from CSS px on HiDPI.
        const px = Math.round((c.x / cssW) * size.width);
        const py = Math.round((c.y / cssH) * size.height);
        if (px < 0 || py < 0 || px >= size.width || py >= size.height) continue;
        // Average a small patch so JPEG-ish noise does not split the buckets.
        let r = 0, g = 0, b = 0, n = 0;
        for (let dy = -3; dy <= 3; dy += 3) {
          for (let dx = -3; dx <= 3; dx += 3) {
            const sx = px + dx;
            const sy = py + dy;
            if (sx < 0 || sy < 0 || sx >= size.width || sy >= size.height) continue;
            const i = (sy * size.width + sx) * 4;
            r += bitmap[i];
            g += bitmap[i + 1];
            b += bitmap[i + 2];
            n += 1;
          }
        }
        if (n === 0) continue;
        const key = `${Math.round(r / n) >> 4},${Math.round(g / n) >> 4},${Math.round(b / n) >> 4}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
      const distinct = seen.size;
      const [topKey, topCount] = [...seen.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["none", 0];
      const sampled = [...seen.values()].reduce((a, b) => a + b, 0);
      const uniform = sampled > 4 && topCount / sampled > 0.8;
      add(
        "Covers render real artwork",
        !uniform && distinct >= Math.min(4, Math.floor(sampled / 2)),
        `${distinct} distinct colours across ${sampled} covers; most common bucket ${topKey} x${topCount}`,
      );
    }

    // Light theme pass, to verify the token overrides apply.
    await win.webContents.executeJavaScript(`(() => {
      document.documentElement.dataset.theme = 'light';
      return true;
    })()`);
    await sleep(600);
    const lightPng = await capture();
    writeFileSync(join(outDir, "smoke-light.png"), lightPng);
    add("Light theme screenshot", lightPng.length > 10000, `smoke-light.png (${(lightPng.length / 1024).toFixed(0)} KB)`);

    // The light surfaces must actually go light, not just change hue. Sample a
    // point verified to be bare shell in both themes.
    const lightProbe = (await win.webContents.executeJavaScript(
      `getComputedStyle(document.body).backgroundColor`,
    )) as string;
    const lightFrame = await win.webContents.capturePage();
    const lightBmp = lightFrame.toBitmap();
    const lightSize = lightFrame.getSize();
    const sample = (bmp: Buffer, size: { width: number; height: number }, x: number, y: number) => {
      const px = Math.round((x / cssW) * size.width);
      const py = Math.round((y / cssH) * size.height);
      const i = (py * size.width + px) * 4;
      return (bmp[i] + bmp[i + 1] + bmp[i + 2]) / 3;
    };
    const gapPoint = probePoints.find((p) => p.label === "grid gap") ?? { x: 640, y: 620 };
    const darkGap = sample(bitmap, size, gapPoint.x, gapPoint.y);
    const lightGap = sample(lightBmp, lightSize, gapPoint.x, gapPoint.y);
    add(
      "Light theme inverts surfaces",
      lightGap > darkGap + 80,
      `body=${lightProbe}, grid gap luminance ${Math.round(darkGap)} -> ${Math.round(lightGap)}`,
    );
    // Inverting the surfaces changes every text token, so the light pass needs
    // its own contrast sweep rather than trusting the dark one.
    const lightAudit = await auditContrast(win);
    add("Every visible text run meets WCAG AA (light)", lightAudit.failing === 0, describeAudit(lightAudit));
    await win.webContents.executeJavaScript(
      `(() => { document.documentElement.dataset.theme = 'dark'; return true; })()`,
    );

    // A coarse ASCII map of the panel boxes, so the report says something about
    // the arrangement even without a human looking at the PNG.
    const map = (await win.webContents.executeJavaScript(`(() => {
      const W = 78, H = 22;
      const grid = Array.from({ length: H }, () => Array(W).fill(' '));
      const labels = [];
      const paint = (sel, ch, label) => {
        const el = document.querySelector(sel);
        if (!el) return;
        const r = el.getBoundingClientRect();
        const x0 = Math.max(0, Math.floor((r.left / window.innerWidth) * W));
        const y0 = Math.max(0, Math.floor((r.top / window.innerHeight) * H));
        const x1 = Math.min(W - 1, Math.ceil((r.right / window.innerWidth) * W) - 1);
        const y1 = Math.min(H - 1, Math.ceil((r.bottom / window.innerHeight) * H) - 1);
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) grid[y][x] = ch;
        if (label) grid[y0][x0] = ch.toUpperCase();
        labels.push(label + ': x' + x0 + '-' + x1 + ' y' + y0 + '-' + y1);
      };
      paint('.titlebar', '-', 'titlebar');
      paint('.sidebar', '|', 'sidebar');
      paint('.main', '.', 'main');
      paint('.station-grid', 'o', 'grid');
      paint('.genre-row', '=', 'genres');
      paint('.nowbar', '_', 'nowbar');
      return grid.map((row) => row.join('')).join('\\n') + '\\n' + labels.join('\\n');
    })()`)) as string;
    writeFileSync(join(outDir, "layout.txt"), map);
    console.log("\n" + map);

    const failed = checks.filter((c) => !c.ok);
    writeFileSync(
      join(outDir, "report.json"),
      JSON.stringify({ checks, failed: failed.length, diagnostics, layout: layout, visuals }, null, 2),
    );

    console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
    app.exit(failed.length === 0 ? 0 : 1);
  } catch (err) {
    console.error("smoke test crashed:", err);
    writeFileSync(join(outDir, "report.json"), JSON.stringify({ checks, crash: String(err) }, null, 2));
    app.exit(2);
  }
}
