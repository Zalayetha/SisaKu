import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createModel } from "@sisaku/agents";
import { toolCallCases, type ToolCallCase } from "./cases";
import { createEvalLens } from "./lens";
import { formatText } from "./report";
import {
  prepareEvalEnvironment,
  runCopilotEval,
  type DatasetName,
  type EvalEnvironment,
} from "./run-eval";

// `pnpm eval`: runs the Copilot evals against a throwaway database (see ADR 0016).
//   --dataset tool-call   only this dataset (repeatable)
//   --case <id>           only these case ids (repeatable)
//   --repeat <n>          run every case n times

const DATASETS: Record<DatasetName, readonly ToolCallCase[]> = { "tool-call": toolCallCases };

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

let lens: ReturnType<typeof createEvalLens>;
let env: EvalEnvironment | undefined;
let exitCode = 1;
try {
  const model = createModel();
  lens = createEvalLens();
  console.error(
    lens ? "Tracing to Lens as sisaku-copilot-eval." : "Lens not configured: no traces.",
  );
  console.error("Preparing the eval database…");
  env = await prepareEvalEnvironment(dbUrl);
  const report = await runCopilotEval({
    env,
    model,
    datasets: names.map((name) => ({ name, cases: DATASETS[name] })),
    ...(values.case ? { caseIds: values.case } : {}),
    repeat,
    print: (text) => process.stdout.write(text),
    ...(commit ? { commit } : {}),
    ...(lens ? { lens } : {}),
  });

  console.log(`\n${formatText(report.suites)}`);
  const dir = fileURLToPath(new URL("./results/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  const file = `${dir}eval-${report.json.run.date.replaceAll(":", "-")}.json`;
  writeFileSync(file, `${JSON.stringify(report.json, null, 2)}\n`);
  console.error(`Result written to ${file}`);
  for (const warning of report.warnings) console.error(`Warning: ${warning}`);
  exitCode = report.exitCode;
} catch (error) {
  // A setup error (bad Lens settings, wrong database, failed migration or seed) is not a score.
  console.error(error instanceof Error ? error.message : error);
  exitCode = 2;
} finally {
  if (lens) {
    try {
      await lens.client.flush();
      await lens.client.close();
    } catch (error) {
      console.error("Lens could not be reached; scores above are unaffected.", error);
    }
  }
  await env?.close();
}
// A timed-out turn may still be running; the result is already written.
process.exit(exitCode);
