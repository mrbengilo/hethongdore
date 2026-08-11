export const DEFAULT_EMPLOYEE_TIKTOK_ALLOWANCE = 25_000;

type AllowanceInput = number | string | null | undefined;

function validAllowance(value: number) {
  return Number.isSafeInteger(value) && value >= 0;
}

function parsedAllowance(input: AllowanceInput) {
  if (input === null || input === undefined || input === "") return null;
  const value = Number(input);
  return validAllowance(value) ? value : null;
}

/** New employees retain the historical 25,000 VND behavior when omitted. */
export function employeeTikTokAllowanceForCreate(input: AllowanceInput) {
  return input === undefined
    ? DEFAULT_EMPLOYEE_TIKTOK_ALLOWANCE
    : parsedAllowance(input);
}

/** Legacy clients omit this field; omission must preserve the stored value. */
export function employeeTikTokAllowanceForPatch(input: AllowanceInput, current: number) {
  if (input === undefined) return validAllowance(current) ? current : null;
  return parsedAllowance(input);
}

/** Validate the effective ACTIVE-shift allowance. Explicit zero is valid. */
export function employeeTikTokAllowanceSnapshot(configured: unknown) {
  const value = Number(configured);
  return validAllowance(value) ? value : null;
}

/** A shift earns this allowance once only when its TikTok checkbox is selected. */
export function earnedTikTokAllowance(hasTikTok: boolean, snapshot: number) {
  if (!hasTikTok) return 0;
  if (!validAllowance(snapshot)) throw new Error("Invalid TikTok allowance snapshot");
  return snapshot;
}
