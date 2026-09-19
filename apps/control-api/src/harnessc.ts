import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { harnessPlanSchema, verifyPlanDigest, type HarnessPlan } from "@ehf/contracts";

const run = promisify(execFile);

/** Plain file name, no separators and no traversal: this value names a file we write. */
const SAFE_FILENAME = /^[A-Za-z0-9._-]+$/;

export class HarnessCompilerError extends Error {
  constructor(message: string, readonly detail: string) {
    super(message);
  }
}

let resolvedBinary: string | null = null;

/**
 * Locate the pinned `harnessc` binary.
 *
 * The compiler is the trust root: it is the only thing that runs the pinned `lgir-core`
 * revision and emits a content-addressed plan. There is deliberately no in-process
 * fallback -- a second implementation is how the author plane came to emit plans that
 * claimed an LGIR revision they never ran.
 */
export async function resolveCompilerBinary(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (resolvedBinary) return resolvedBinary;
  // An explicitly configured path is the only candidate. Falling back to a different
  // binary because the configured one is missing would silently change which compiler
  // -- and therefore which pinned lgir-core revision -- produced an admitted plan.
  const candidates = env.HARNESSC_PATH ? [env.HARNESSC_PATH] : [
    // Local development: `cargo build --release` output, relative to the repository root.
    resolve(fileURLToPath(new URL("../../../", import.meta.url)), "target/release/harnessc"),
    "/usr/local/bin/harnessc",
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      resolvedBinary = candidate;
      return candidate;
    } catch { /* try the next candidate */ }
  }
  throw new HarnessCompilerError(
    "compiler.binary_missing",
    `harnessc was not found or is not executable. Checked: ${candidates.join(", ")}. Set HARNESSC_PATH.`,
  );
}

export function resetCompilerBinaryCache(): void {
  resolvedBinary = null;
}

/**
 * Compile authoring sources into a plan by invoking `harnessc` over a temporary package
 * directory. The directory contains exactly the two authored files, so the compiler's
 * dependency manifest and package digest stay deterministic for identical sources.
 */
export async function compileWithHarnessc(input: {
  packageSource: string;
  workflowSource: string;
  workflowFileName: string;
  modelProfilesPath: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<HarnessPlan> {
  if (!SAFE_FILENAME.test(input.workflowFileName)) {
    throw new HarnessCompilerError("compiler.workflow_filename_invalid", input.workflowFileName);
  }
  const binary = await resolveCompilerBinary(input.env);
  const workspace = await mkdtemp(join(tmpdir(), "harnessc-"));
  const directory = join(workspace, "package");
  try {
    // The plan is written outside the package directory: the compiler's dependency
    // manifest is a walk of that directory, so its own output must not land in it.
    const planPath = join(workspace, "plan.json");
    await mkdir(directory);
    await writeFile(join(directory, "package.yaml"), input.packageSource, "utf8");
    await writeFile(join(directory, input.workflowFileName), input.workflowSource, "utf8");
    try {
      await run(binary, [
        "compile", directory,
        "--out", planPath,
        "--model-profiles", resolve(input.modelProfilesPath),
      ], { timeout: input.timeoutMs ?? 60_000, maxBuffer: 16 * 1024 * 1024 });
    } catch (error) {
      const detail = error && typeof error === "object" && "stderr" in error
        ? String((error as { stderr: unknown }).stderr).trim()
        : error instanceof Error ? error.message : "unknown compiler failure";
      throw new HarnessCompilerError("compiler.invocation_failed", detail);
    }
    const document = JSON.parse(await readFile(planPath, "utf8")) as unknown;
    const parsed = harnessPlanSchema.safeParse(document);
    if (!parsed.success) {
      throw new HarnessCompilerError("compiler.plan_contract_violation", JSON.stringify(parsed.error.issues.slice(0, 8)));
    }
    if (!verifyPlanDigest(parsed.data)) {
      throw new HarnessCompilerError("compiler.plan_digest_invalid", parsed.data.planDigest);
    }
    return parsed.data;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
