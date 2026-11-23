import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import * as vega from "vega";
import { compile, type TopLevelSpec } from "vega-lite";

/** A Vega-Lite spec. Its `data.values` are the numbers the chart shows (ADR 0015). */
export type ChartSpec = TopLevelSpec;

/** Draws a chart spec as PNG bytes. Vega-Lite + resvg in production; a recording fake in tests. */
export type ChartRenderer = { render(spec: ChartSpec): Promise<Buffer> };

const FONT_DIR = fileURLToPath(new URL("../../assets/fonts/", import.meta.url));
const FONT_FILES = ["NotoSans-Regular.ttf", "NotoSans-Bold.ttf"].map((f) => FONT_DIR + f);

/**
 * Renders in-process, so no outlet data leaves the server (ADR 0012). resvg loads only the
 * bundled Noto Sans: a slim container has no system fonts, and labels would be blank.
 * Fails fast if a font file is missing.
 */
export async function createChartRenderer(): Promise<ChartRenderer> {
  await Promise.all(FONT_FILES.map((f) => access(f)));
  return {
    async render(spec) {
      const view = new vega.View(vega.parse(compile(spec).spec), { renderer: "none" });
      try {
        const svg = await view.toSVG();
        return new Resvg(svg, {
          font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: "Noto Sans" },
          background: "white",
          fitTo: { mode: "zoom", value: 2 }, // sharp on phone screens
        })
          .render()
          .asPng();
      } finally {
        view.finalize();
      }
    },
  };
}
