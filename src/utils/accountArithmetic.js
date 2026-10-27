/** Pure arithmetic for the raw per-account balance read model. */
export function accountRowsFromMovements(accounts, inflows = [], directOutflows = [], splitOutflows = []) {
  const round2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
  const inMap = new Map();
  const outMap = new Map();
  for (const row of inflows) {
    const id = String(row._id);
    inMap.set(id, (inMap.get(id) || 0) + Number(row.total || 0));
  }
  for (const row of [...directOutflows, ...splitOutflows]) {
    const id = String(row._id);
    outMap.set(id, (outMap.get(id) || 0) + Number(row.total || 0));
  }
  const result = accounts.map((account) => ({
    accountId: account._id,
    name: account.name,
    type: account.type,
    owner: account.owner,
    balance: round2(Number(account.openingBalance || 0) + (inMap.get(String(account._id)) || 0) - (outMap.get(String(account._id)) || 0)),
  }));
  return { accounts: result, total: round2(result.reduce((sum, account) => sum + account.balance, 0)) };
}
