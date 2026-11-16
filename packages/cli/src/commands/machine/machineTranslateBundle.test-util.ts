import {
  planBundleTranslation,
  translateMissing,
  type BundleTranslationPlan,
} from "./machineTranslateBundle.js";
import type { AnyMachineTranslateProvider } from "./providers/types.js";

/** Translates what one bundle is missing, as the command does for all. */
export async function machineTranslateBundle(
  args: Parameters<typeof planBundleTranslation>[0] & {
    provider: AnyMachineTranslateProvider;
  },
): Promise<
  Partial<ReturnType<BundleTranslationPlan["apply"]>> &
    Partial<Omit<BundleTranslationPlan, "missing" | "apply">> & {
      error?: string;
    }
> {
  const plan = planBundleTranslation(args);
  if ("error" in plan) return plan;
  const { missing, apply, ...report } = plan;
  const result = await translateMissing({ ...args, missing });
  return result.ok
    ? { ...apply(result.translations), ...report }
    : { error: result.error };
}
