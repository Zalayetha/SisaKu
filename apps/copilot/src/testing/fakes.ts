import type { ChartRenderer, ChartSpec } from "../charts/render";
import type { FeedbackScorer } from "../waste/feedback";
import type { PhotoStore } from "../waste/photos";

// Shared by the turn handler tests and the Copilot evals: stand-ins for the photos volume, the
// chart renderer and Lens scores.

/** Stands in for the photos volume. */
export class FakePhotoStore implements PhotoStore {
  readonly saved: { path: string; data: Buffer }[] = [];
  async save(path: string, data: Buffer) {
    this.saved.push({ path, data });
    return path;
  }
}

/** Stands in for the chart renderer: keeps every spec, returns fake PNG bytes. */
export class RecordingRenderer implements ChartRenderer {
  readonly specs: ChartSpec[] = [];
  constructor(private readonly failing = false) {}
  async render(spec: ChartSpec) {
    if (this.failing) throw new Error("resvg crashed");
    this.specs.push(spec);
    return Buffer.from("png");
  }
  /** The data rows of the latest chart. */
  values() {
    return (this.specs.at(-1)!.data as { values: unknown[] }).values;
  }
}

/** Stands in for Lens scores. */
export class RecordingScorer implements FeedbackScorer {
  readonly scores: Parameters<FeedbackScorer["score"]>[0][] = [];
  score(args: Parameters<FeedbackScorer["score"]>[0]) {
    this.scores.push(args);
  }
}
