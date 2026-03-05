export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

export function splitEqual(total, userIds) {
  const each = round2(total / userIds.length);
  let sum = 0;
  const rows = userIds.map((id) => {
    sum += each;
    return { userId: id, shareAmount: each };
  });
  const diff = round2(total - sum);
  if (diff !== 0 && rows.length) rows[0].shareAmount = round2(rows[0].shareAmount + diff);
  return rows;
}

export function splitPersonal(total, userId) {
  return [{ userId, shareAmount: round2(total) }];
}

export function splitRatio(total, ratios) {
  let sumRatio = 0;
  for (const r of ratios) sumRatio += Number(r.ratio || 0);
  if (round2(sumRatio) !== 100) throw new Error("ratios must sum to 100");

  let sum = 0;
  const rows = ratios.map((r) => {
    const share = round2((total * Number(r.ratio)) / 100);
    sum += share;
    return { userId: r.userId, shareAmount: share };
  });
  const diff = round2(total - sum);
  if (diff !== 0 && rows.length) rows[0].shareAmount = round2(rows[0].shareAmount + diff);
  return rows;
}

export function splitFixed(total, fixed) {
  let sum = 0;
  const rows = fixed.map((f) => {
    const share = round2(Number(f.amount || 0));
    sum += share;
    return { userId: f.userId, shareAmount: share };
  });
  if (round2(sum) !== round2(total)) throw new Error("fixed amounts must sum to total");
  return rows;
}