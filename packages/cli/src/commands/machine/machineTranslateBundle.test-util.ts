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
  Partial<ReturnType<BundleTranslationPlan["apply"]>> & { error?: string }
> {
  const plan = planBundleTranslation({
    ...args,
    supportsContext: args.provider.supportsContext,
  });
  if ("error" in plan) return plan;
  const result = await translateMissing({ ...args, missing: plan.missing });
  return result.ok ? plan.apply(result.translations) : { error: result.error };
}
