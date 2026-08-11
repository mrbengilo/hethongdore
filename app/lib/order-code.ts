const LEADING_BRAND_WORDS = new Set(["DORE", "STORE"]);

function asciiWords(value: string) {
  return value
    .trim()
    .replaceAll("Đ", "D")
    .replaceAll("đ", "d")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toUpperCase()
    .match(/[A-Z0-9]+/gu) ?? [];
}

/**
 * Derive the immutable prefix used when the next order is allocated.
 * The DORE brand is not part of the store identity: DORE CẦN THƠ -> CT.
 */
export function storeOrderCodePrefix(storeName: string) {
  const words = asciiWords(storeName);
  const firstWord = () => words.at(0) ?? "";
  while (words.length > 1 && LEADING_BRAND_WORDS.has(firstWord())) words.shift();
  if (words.length > 2 && firstWord() === "CUA" && (words.at(1) ?? "") === "HANG") words.splice(0, 2);
  while (words.length > 1 && LEADING_BRAND_WORDS.has(firstWord())) words.shift();
  const prefix = words.map((word) => word.charAt(0)).join("").slice(0, 8);
  return prefix || "CH";
}

export function storeOrderCodePrefixCandidate(basePrefix: string, ordinal: number) {
  return ordinal <= 1 ? basePrefix : `${basePrefix}${ordinal}`;
}

export function nextAvailableStoreOrderCodePrefix(basePrefix: string, occupied: ReadonlySet<string>) {
  for (let ordinal = 1; ordinal <= 100_000; ordinal += 1) {
    const candidate = storeOrderCodePrefixCandidate(basePrefix, ordinal);
    if (!occupied.has(candidate)) return candidate;
  }
  throw new Error(`Unable to allocate a unique order-code prefix for ${basePrefix}`);
}

export function prefixFromStoreOrderCode(code: string) {
  return /^([A-Z0-9]+)-([0-9]+)$/u.exec(code)?.[1] ?? null;
}
