/**
 * Generates every brand derivative Spec.md §6.1 asks for, from the vector master.
 *
 *   brand/aies-logo-source.svg  ──►  public/brand/{5 svgs} + {4 raster icons}
 *
 * Run with `npm run brand`. Committing the *outputs* is deliberate: Vercel builds must not
 * depend on this script, and the assets change roughly never. Re-run it only when the master
 * artwork changes.
 *
 * Why a script rather than hand-edited SVGs: the master is an 802-path auto-trace with a baked
 * white background. Every derivative needs the same three corrections (drop the background, drop
 * the flattened drop-shadow, tighten the viewBox), and doing that by hand once means it can never
 * be redone when better artwork arrives. See docs/DECISIONS.md #15.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

// Run from the repo root via `npm run brand`, same as scripts/ensure-storage-bucket.ts.
const SOURCE = join(process.cwd(), "brand", "aies-logo-source.svg");
const OUT = join(process.cwd(), "public", "brand");

/** Spec.md §6.2. Duplicated here rather than imported from CSS so this script has no runtime deps. */
const NAVY_800 = "#012076";

interface ParsedPath {
  fill: string;
  d: string;
}

function parsePaths(svg: string): ParsedPath[] {
  const re = /<path\b[^>]*?\bfill="(#[0-9A-Fa-f]+)"[^>]*?\bd="([\s\S]*?)"\s*\/>/g;
  const out: ParsedPath[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg)) !== null) out.push({ fill: m[1]!, d: m[2]! });
  return out;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Coordinate-stream bbox. Ignores curve control points bulging outside the hull, which is fine
 *  here — it is used for classification and for a viewBox that gets a margin added anyway. */
function bboxOf(d: string): Box {
  const nums = d.match(/-?\d+(?:\.\d+)?/g) ?? [];
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const x = Number(nums[i]);
    const y = Number(nums[i + 1]);
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

function union(boxes: Box[]): Box {
  return boxes.reduce((a, b) => ({
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  }));
}

/** The trace carries 6 decimal places on every coordinate — ~4x more precision than a 1536-unit
 *  viewBox can express. Rounding to 2dp is visually lossless and is most of the size win. */
function roundCoords(d: string, precision = 2): string {
  return d
    .replace(/-?\d+\.\d+/g, (n) => String(Number(Number(n).toFixed(precision))))
    .replace(/\s+/g, " ")
    .trim();
}

function svgDoc(viewBox: string, body: string, title: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" role="img" aria-label="${title}">` +
    `<title>${title}</title>${body}</svg>\n`
  );
}

function main(): string {
  if (!existsSync(SOURCE)) {
    throw new Error(
      `Missing ${SOURCE}. Drop the vector master there (see docs/DECISIONS.md #15) and re-run.`,
    );
  }
  mkdirSync(OUT, { recursive: true });

  const src = readFileSync(SOURCE, "utf8");
  const viewBoxMatch = /viewBox="([^"]+)"/.exec(src);
  if (!viewBoxMatch) throw new Error("Source SVG has no viewBox.");
  const [, , srcW, srcH] = viewBoxMatch[1]!.split(/\s+/).map(Number) as [
    number,
    number,
    number,
    number,
  ];

  const paths = parsePaths(src);
  if (paths.length === 0) throw new Error("Parsed 0 paths from the source SVG.");

  // ---- classify -----------------------------------------------------------------------------
  // (a) The background: white, and covering essentially the whole canvas. Its *inner* subpaths are
  //     the logo knocked out of that rectangle, which is exactly a silhouette — reused below.
  const bgIndex = paths.findIndex((p) => {
    if (p.fill.toUpperCase() !== "#FFFFFF") return false;
    const b = bboxOf(p.d);
    return (b.x1 - b.x0) / srcW > 0.95 && (b.y1 - b.y0) / srcH > 0.95;
  });
  if (bgIndex === -1) throw new Error("Could not find the white background path.");
  const background = paths[bgIndex]!;

  // (b) The drop shadow: the master is a flattened trace of a *soft* shadow, so it survives as a
  //     flat grey sliver ~120:1 wide. At sidebar size it reads as a stray rule under the logo, and
  //     a logo should not carry a baked shadow into a PDF header anyway. Dropped everywhere.
  const isShadow = (p: ParsedPath): boolean => {
    const b = bboxOf(p.d);
    const w = b.x1 - b.x0;
    const h = b.y1 - b.y0;
    return h > 0 && w / h > 50 && w / srcW > 0.5;
  };

  const artwork = paths.filter((p, i) => i !== bgIndex && !isShadow(p));
  const content = union(artwork.map((p) => bboxOf(p.d)));

  // Spec.md §6.1: "keep clear space of at least the cap-height of the A on all sides". Baking a
  // little of that into the viewBox means call sites cannot accidentally crowd the mark.
  const pad = Math.round((content.y1 - content.y0) * 0.06);
  const vbX = Math.round(content.x0) - pad;
  const vbY = Math.round(content.y0) - pad;
  const vbW = Math.round(content.x1 - content.x0) + pad * 2;
  const vbH = Math.round(content.y1 - content.y0) + pad * 2;
  const vb = [vbX, vbY, vbW, vbH].join(" ");

  // ---- 1. primary, full colour --------------------------------------------------------------
  const logoBody = artwork.map((p) => `<path fill="${p.fill}" d="${roundCoords(p.d)}"/>`).join("");
  writeFileSync(
    join(OUT, "aies-logo.svg"),
    svgDoc(vb, logoBody, "AIES Electromechanical Corporation"),
  );

  // ---- 2 & 3. mono silhouettes ---------------------------------------------------------------
  // Built from two different sources, because neither one alone is good enough:
  //
  //  * Wordmark + gear come from the background path's knockout subpaths. These are big, simple
  //    shapes and the knockout traces them crisply.
  //  * The tagline comes from its own letter paths. The knockout renders 8px type far more
  //    coarsely — it fills the "O" of ELECTROMECHANICAL in solid and melts "ME" together — so
  //    reusing it there would ship a visibly broken wordmark. It costs 48 extra paths (~20kB).
  //
  // The two are combined through a luminance mask rather than a compound path: the tagline's
  // counters are separate light-coloured shapes painted *over* the letters by the tracer, not
  // holes in them, and a mask can subtract them without boolean path arithmetic.
  const TAGLINE_TOP = 680;

  const bgSubpaths = background.d.split(/(?=M)/).filter((s) => s.trim().length > 0);
  const bigShapes = bgSubpaths.slice(1).filter((s) => {
    const b = bboxOf(s);
    const w = b.x1 - b.x0;
    const h = b.y1 - b.y0;
    if (h > 0 && w / h > 50) return false; // the shadow
    return b.y0 < TAGLINE_TOP;
  });

  const taglinePaths = artwork.filter((p) => bboxOf(p.d).y0 >= TAGLINE_TOP);
  // Dark shapes are the glyphs; light ones are counters and the tracer's anti-alias halo.
  const luminance = (hex: string): number =>
    (0.299 * parseInt(hex.slice(1, 3), 16) +
      0.587 * parseInt(hex.slice(3, 5), 16) +
      0.114 * parseInt(hex.slice(5, 7), 16)) /
    255;
  const glyphs = taglinePaths.filter((p) => luminance(p.fill) < 0.5);
  const holes = taglinePaths.filter((p) => luminance(p.fill) >= 0.5);

  // evenodd rather than the default nonzero: the two render identically on this artwork, but
  // evenodd makes every enclosed region a hole regardless of winding direction, so replacement
  // artwork traced by a different tool cannot silently fill in the letter counters.
  const maskBody =
    `<path fill="#fff" fill-rule="evenodd" d="${roundCoords(bigShapes.join(""))}"/>` +
    `<path fill="#fff" fill-rule="evenodd" d="${roundCoords(glyphs.map((p) => p.d).join(""))}"/>` +
    (holes.length > 0
      ? `<path fill="#000" d="${roundCoords(holes.map((p) => p.d).join(""))}"/>`
      : "");

  const monoBody = (color: string): string =>
    `<defs><mask id="m" maskUnits="userSpaceOnUse" x="${vbX}" y="${vbY}" width="${vbW}" height="${vbH}">` +
    `${maskBody}</mask></defs>` +
    `<rect x="${vbX}" y="${vbY}" width="${vbW}" height="${vbH}" fill="${color}" mask="url(#m)"/>`;
  writeFileSync(
    join(OUT, "aies-logo-mono-white.svg"),
    svgDoc(vb, monoBody("#FFFFFF"), "AIES Electromechanical Corporation"),
  );
  writeFileSync(
    join(OUT, "aies-logo-mono-dark.svg"),
    svgDoc(vb, monoBody(NAVY_800), "AIES Electromechanical Corporation"),
  );

  // ---- 4. the mark ---------------------------------------------------------------------------
  const mark = buildMark();
  writeFileSync(join(OUT, "aies-mark.svg"), mark);

  // ---- report --------------------------------------------------------------------------------
  const kb = (s: string) => (Buffer.byteLength(s) / 1024).toFixed(0) + "kB";
  console.log(`source              ${kb(src)}  (${paths.length} paths)`);
  console.log(
    `content viewBox     ${vb}  ratio ${((content.x1 - content.x0) / (content.y1 - content.y0)).toFixed(2)}:1`,
  );
  console.log(
    `aies-logo.svg       ${kb(readFileSync(join(OUT, "aies-logo.svg"), "utf8"))}  (${artwork.length} paths, background + shadow dropped)`,
  );
  console.log(
    `mono-white/dark     ${kb(readFileSync(join(OUT, "aies-logo-mono-white.svg"), "utf8"))}  (${bigShapes.length} knockout shapes + ${glyphs.length} tagline glyphs - ${holes.length} counters)`,
  );
  console.log(`aies-mark.svg       ${kb(mark)}`);

  return mark;
}

/**
 * PWA and browser icons, all from the mark.
 *
 * Every one is composited onto solid white rather than left transparent: iOS flattens a
 * transparent apple-touch-icon onto black, and Android adaptive icons crop to a circle, so a
 * transparent square is the one thing that reliably looks broken on a phone. The 12% inset is the
 * maskable safe zone.
 */
async function buildRasters(markSvg: string): Promise<void> {
  const svg = Buffer.from(markSvg);
  const render = async (size: number): Promise<Buffer> => {
    const inner = Math.round(size * 0.76);
    const pad = Math.round((size - inner) / 2);
    return sharp(svg, { density: 384 })
      .resize({ width: inner, height: inner, fit: "contain", background: "#FFFFFF" })
      .extend({
        top: pad,
        bottom: size - inner - pad,
        left: pad,
        right: size - inner - pad,
        background: "#FFFFFF",
      })
      .flatten({ background: "#FFFFFF" })
      .png({ compressionLevel: 9 })
      .toBuffer();
  };

  for (const [name, size] of [
    ["icon-192.png", 192],
    ["icon-512.png", 512],
    ["apple-touch-icon.png", 180],
  ] as const) {
    writeFileSync(join(OUT, name), await render(size));
    console.log(`${name.padEnd(20)}${size}x${size}`);
  }

  // favicon.ico. sharp has no ICO encoder and this does not justify a dependency: an .ico is a
  // 6-byte header, a 16-byte directory entry per image, then the payloads — and every browser
  // still in use accepts PNG payloads inside the container.
  const sizes = [16, 32, 48];
  const pngs = await Promise.all(sizes.map(render));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const entries = sizes.map((size, i) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); // palette size
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(pngs[i]!.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += pngs[i]!.length;
    return e;
  });
  writeFileSync(join(OUT, "favicon.ico"), Buffer.concat([header, ...entries, ...pngs]));
  console.log(`favicon.ico         ${sizes.join("/")}px`);
}

/**
 * The gear glyph, rebuilt as clean geometry rather than extracted from the trace.
 *
 * In the artwork the "S" of the wordmark sits on top of the gear, so the traced gear paths have an
 * S-shaped void through them — cropping them yields a gear with a bite taken out, which is not
 * usable as a favicon. The proportions below were measured off the source raster instead (circle
 * fit + radial fill profile): 12 teeth at a 30 degree pitch, hole below 0.45R, solid ring
 * 0.56-0.88R, teeth 0.88-1.0R at roughly a 50% duty cycle.
 */
function buildMark(): string {
  const TEETH = 12;
  const CX = 50;
  const CY = 50;
  const R_TIP = 48;
  const R_ROOT = 42;
  const R_RING_INNER = 27;
  const TIP_HALF_DEG = 6.6;
  const ROOT_HALF_DEG = 9.2;

  const pt = (r: number, deg: number): string => {
    const a = (deg * Math.PI) / 180;
    return `${(CX + r * Math.cos(a)).toFixed(2)} ${(CY + r * Math.sin(a)).toFixed(2)}`;
  };

  // Teeth as one path: each tooth is a trapezoid standing on the root circle. They are sunk 2
  // units *into* the ring rather than sitting tangent to it, so no hairline seam shows along the
  // join at large sizes. That overlap is why the teeth are a separate <path> from the ring below
  // — inside one evenodd path, an overlap would punch a hole instead of merging.
  let teeth = "";
  for (let i = 0; i < TEETH; i++) {
    const c = (360 / TEETH) * i - 90;
    teeth +=
      `M${pt(R_ROOT - 2, c - ROOT_HALF_DEG)}` +
      `L${pt(R_TIP, c - TIP_HALF_DEG)}` +
      `L${pt(R_TIP, c + TIP_HALF_DEG)}` +
      `L${pt(R_ROOT - 2, c + ROOT_HALF_DEG)}Z`;
  }

  // Annulus drawn as two opposing circles so the centre is a genuine hole at any fill-rule.
  const ring =
    `M${CX} ${CY - R_ROOT}A${R_ROOT} ${R_ROOT} 0 1 0 ${CX} ${CY + R_ROOT}A${R_ROOT} ${R_ROOT} 0 1 0 ${CX} ${CY - R_ROOT}Z` +
    `M${CX} ${CY - R_RING_INNER}A${R_RING_INNER} ${R_RING_INNER} 0 1 1 ${CX} ${CY + R_RING_INNER}A${R_RING_INNER} ${R_RING_INNER} 0 1 1 ${CX} ${CY - R_RING_INNER}Z`;

  // Light from the upper right, matching the chrome in the artwork.
  const grad =
    `<linearGradient id="g" x1="0" y1="1" x2="1" y2="0">` +
    `<stop offset="0" stop-color="#011860"/>` +
    `<stop offset="0.55" stop-color="#003999"/>` +
    `<stop offset="1" stop-color="#0994E3"/>` +
    `</linearGradient>`;

  const body =
    `<defs>${grad}</defs>` +
    `<path fill="url(#g)" fill-rule="evenodd" d="${ring}"/>` +
    `<path fill="url(#g)" d="${teeth}"/>` +
    // The artwork's inner chrome ring. Vanishes gracefully below ~32px.
    `<circle cx="${CX}" cy="${CY}" r="23.5" fill="none" stroke="url(#g)" stroke-width="2.4"/>`;

  return svgDoc("0 0 100 100", body, "AIES");
}

buildRasters(main()).catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
