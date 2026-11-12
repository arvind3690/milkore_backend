/** "+919876543210" → "+91******3210". Never log full phone numbers. */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  if (phone.length <= 7) return '****';
  return `${phone.slice(0, 3)}${'*'.repeat(phone.length - 7)}${phone.slice(-4)}`;
}

/** Rounds a coordinate to 2 decimals (about 1 km) for logs. */
export function roundCoord(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Formats paise as a rupee string: 6050 → "₹60.50", 6000 → "₹60". */
export function formatRupees(paise: number): string {
  const rupees = paise / 100;
  const text = Number.isInteger(rupees)
    ? rupees.toLocaleString('en-IN')
    : rupees.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `₹${text}`;
}
