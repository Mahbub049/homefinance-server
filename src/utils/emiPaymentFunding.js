// Pure normalization for EMI payment funding. Expense responsibility belongs
// to the EMI plan; this module only says whose actual accounts paid the bill.
const idOf = (value) => String(value?._id || value?.id || value || "");
const cents = (value) => Math.round(Number(value) * 100);

export function parseEmiPaymentDate(dateString) {
  if (dateString == null || dateString === "") return new Date();
  if (typeof dateString !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateString))
    throw new Error("পরিশোধের তারিখ সঠিক নয়।");
  const date = new Date(`${dateString}T12:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== dateString)
    throw new Error("পরিশোধের তারিখ সঠিক নয়।");
  return date;
}

function ownerMatches(ownerValue, nameValue) {
  const owner = String(ownerValue || "").trim().toLowerCase();
  if (owner === "joint") return true;
  const name = String(nameValue || "").trim().toLowerCase();
  return (owner === "mahbub" && name.includes("mahbub")) ||
         (owner === "mirza" && name.includes("mirza"));
}

export function normalizeEmiPaymentFunding({
  paymentMode, paidByUserId, fromAccountId, paymentParts,
  totalAmount, familyMembers, accounts,
}) {
  const totalCents = cents(totalAmount);
  if (!Number.isSafeInteger(totalCents) || totalCents <= 0)
    throw new Error("কিস্তির টাকার পরিমাণ সঠিক নয়।");
  const memberById = new Map((familyMembers || []).map((m) => [idOf(m.userId), m]));
  const accountById = new Map((accounts || []).map((a) => [idOf(a), a]));
  const validate = (userId, accountId) => {
    const member = memberById.get(String(userId));
    const account = accountById.get(String(accountId));
    if (!member) throw new Error("পরিশোধকারী পরিবারের সদস্য হতে হবে।");
    if (!account || account.isActive === false ||
      !["cash", "bank", "wallet"].includes(String(account.type || "").toLowerCase()) ||
      String(account.name || "").toLowerCase().includes("saving"))
      throw new Error("সক্রিয় নগদ, ব্যাংক বা মোবাইল ওয়ালেট বেছে নিন।");
    if (!ownerMatches(account.owner, member.userId?.name))
      throw new Error("নির্বাচিত অ্যাকাউন্টটি পরিশোধকারীর নয়।");
  };
  if (paymentMode !== "split") {
    const userId = idOf(paidByUserId);
    const accountId = idOf(fromAccountId);
    validate(userId, accountId);
    return { paymentMode: "single", paidByUserId: userId,
      fromAccountId: accountId,
      paymentParts: [{ userId, accountId, amount: totalCents / 100 }] };
  }
  if (!Array.isArray(paymentParts) || paymentParts.length < 2)
    throw new Error("ভাগ করে পরিশোধের জন্য অন্তত দুজন সদস্য প্রয়োজন।");
  if (paymentParts.length > memberById.size)
    throw new Error("একই সদস্য একাধিকবার রাখা যাবে না।");
  const seenUsers = new Set();
  const seenAccounts = new Set();
  let paidCents = 0;
  const parts = paymentParts.map((part) => {
    const userId = idOf(part.userId);
    const accountId = idOf(part.accountId);
    const amountCents = cents(part.amount);
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0 ||
      Math.abs(Number(part.amount) * 100 - amountCents) > 0.001)
      throw new Error("ভাগ করা টাকার পরিমাণ সঠিক নয় (সর্বোচ্চ দুই দশমিক)।");
    if (seenUsers.has(userId)) throw new Error("একজন সদস্যের জন্য একটি payment row রাখুন।");
    if (seenAccounts.has(accountId)) throw new Error("একই অ্যাকাউন্ট দুইবার রাখা যাবে না।");
    validate(userId, accountId);
    seenUsers.add(userId);
    seenAccounts.add(accountId);
    paidCents += amountCents;
    return { userId, accountId, amount: amountCents / 100 };
  });
  if (paidCents !== totalCents)
    throw new Error("সবার দেওয়া টাকা যোগ করলে সম্পূর্ণ কিস্তির সমান হতে হবে।");
  return { paymentMode: "split", paidByUserId: null, fromAccountId: null, paymentParts: parts };
}
