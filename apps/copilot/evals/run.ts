import { execSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createLens, createModel } from "@sisaku/agents";
import { loadToolCallDataset } from "./cases";
import { formatMarkdown, formatText } from "./report";
import { prepareEvalEnvironment, runCopilotEval, type DatasetName } from "./run-eval";

// `pnpm eval`: runs the Copilot evals against a throwaway database (see ADR 0016).
//   --dataset tool-call   only this dataset (repeatable)
//   --case <id>           only these case ids (repeatable)
//   --repeat <n>          run every case n times

const LENS_ENV = ["ANVIA_LENS_BASE_URL", "ANVIA_LENS_PUBLIC_KEY", "ANVIA_LENS_SECRET_KEY"];
const DATASETS: Record<DatasetName, () => ReturnType<typeof loadToolCallDataset>["cases"]> = {
  "tool-call": () => loadToolCallDataset().cases,
};

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const { values } = parseArgs({
  options: {
    dataset: { type: "string", multiple: true },
    case: { type: "string", multiple: true },
    repeat: { type: "string" },
  },
});
const names = (values.dataset ?? Object.keys(DATASETS)) as DatasetName[];
for (const name of names) if (!(name in DATASETS)) fail(`Unknown dataset ${name}`);
const repeat = values.repeat === undefined ? 1 : Number(values.repeat);
if (!Number.isInteger(repeat) || repeat < 1) fail("--repeat must be a whole number of 1 or more");

const dbUrl = process.env.TEST_DATABASE_URL;
if (!dbUrl)
  fail("TEST_DATABASE_URL is not set: the eval needs a throwaway database ending in _test");
if (!process.env.LLM_API_KEY) fail("LLM_API_KEY is not set: the eval calls the production model");

const commit = (() => {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: "pipe" }).toString().trim();
  } catch {
    return undefined;
  }
})();

const model = createModel();
// Lens is optional: eval traces go under their own service name with full content, because they
// hold only mock data; production stays in safe capture mode (ADR 0012, ADR 0016).
const lens = LENS_ENV.every((name) => process.env[name])
  ? createLens("sisaku-copilot-eval")
  : undefined;
console.error(lens ? "Tracing to Lens as sisaku-copilot-eval." : "Lens not configured: no traces.");

console.error("Preparing the eval database…");
const env = await prepareEvalEnvironment(dbUrl);
let exitCode: number = 1;
try {
  const report = await runCopilotEval({
    env,
    model,
    datasets: names.map((name) => ({ name, cases: DATASETS[name]() })),
    ...(values.case ? { caseIds: values.case } : {}),
    repeat,
    ...(commit ? { commit } : {}),
    ...(lens
      ? {
          lens: {
            observer: lens.observer({ captureMode: "full" }),
            reporters: [lens.evalReporter()],
          },
        }
      : {}),
  });

  console.log(formatText(report.suites));
  const dir = fileURLToPath(new URL("./results/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  const file = `${dir}eval-${report.json.run.date.replaceAll(":", "-")}.json`;
  writeFileSync(file, `${JSON.stringify(report.json, null, 2)}\n`);
  console.error(`Result written to ${file}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, formatMarkdown(report.suites));
  }
  exitCode = report.exitCode;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  exitCode = 2;
} finally {
  if (lens) {
    try {
      await lens.flush();
      await lens.close();
    } catch (error) {
      console.error("Lens could not be reached; scores above are unaffected.", error);
    }
  }
  await env.close();
}
// A timed-out turn may still be running; the result is already written.
process.exit(exitCode);
