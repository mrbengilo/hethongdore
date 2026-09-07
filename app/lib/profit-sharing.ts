import { multiplyRatioVnd, requireVnd, sumVnd } from "./finance";

export type SetupRepayment = Readonly<{ storeId: string; amount: number }>;
type MemberRate = Readonly<{ memberId: string; rateBasisPoints: number }>;

/** Allocate integer VND once per store, preserving its exact total. */
export function allocateProfitShares<T extends MemberRate>(total: number, members: readonly T[]) {
  requireVnd(total, "distributableProfit");
  if (!members.length || new Set(members.map((member) => member.memberId)).size !== members.length
    || members.some((member) => !Number.isInteger(member.rateBasisPoints) || member.rateBasisPoints < 0)
    || members.reduce((sum, member) => sum + member.rateBasisPoints, 0) !== 10_000) {
    throw new RangeError("Tỷ lệ chia lợi nhuận của các thành viên phải đủ 100%.");
  }
  let cumulativeRate = 0;
  let allocated = 0;
  return members.map((member) => {
    cumulativeRate += member.rateBasisPoints;
    const target = multiplyRatioVnd(total, cumulativeRate, 10_000);
    const amount = target - allocated;
    allocated = target;
    return { ...member, amount };
  });
}

/** Shared by the preview and server close; never changes the source P&L. */
export function calculateProfitSharing<S extends { storeId: string; finalProfit: number }, M extends MemberRate>(
  sourceStores: readonly S[],
  members: readonly M[],
  setupRepayments: readonly SetupRepayment[] = [],
) {
  const storeIds = new Set(sourceStores.map((store) => store.storeId));
  const repayments = new Map<string, number>();
  if (!Array.isArray(setupRepayments)) throw new RangeError("Danh sách hoàn trả setup không hợp lệ.");
  for (const entry of setupRepayments) {
    if (!entry || !storeIds.has(entry.storeId) || repayments.has(entry.storeId)) {
      throw new RangeError("Cửa hàng hoàn trả setup không hợp lệ hoặc bị trùng.");
    }
    if (typeof entry.amount !== "number" || !Number.isSafeInteger(entry.amount) || entry.amount < 0) {
      throw new RangeError("Hoàn trả setup phải là số đồng nguyên, không âm.");
    }
    repayments.set(entry.storeId, entry.amount);
  }
  const stores = sourceStores.map((store) => {
    const setupRepayment = repayments.get(store.storeId) ?? 0;
    const profitAfterSetup = requireVnd(store.finalProfit, "finalProfit", true) - setupRepayment;
    requireVnd(profitAfterSetup, "profitAfterSetup", true);
    const distributableProfit = Math.max(0, profitAfterSetup);
    return {
      ...store,
      setupRepayment,
      profitAfterSetup,
      distributableProfit,
      members: allocateProfitShares(distributableProfit, members),
    };
  });
  return {
    stores,
    totalSetupRepayment: sumVnd(stores.map((store) => store.setupRepayment)),
    totalDistributableProfit: sumVnd(stores.map((store) => store.distributableProfit)),
    members: members.map((member, index) => ({
      ...member,
      amount: sumVnd(stores.map((store) => store.members[index].amount)),
    })),
  };
}
