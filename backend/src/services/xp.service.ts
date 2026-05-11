export function calculateLevel(xp: number): { level: string; nextThreshold: number } {
  let lvl = 'Bronze'; let next = 10;
  if (xp >= 30) { lvl = 'Diamond'; next = 40; }
  else if (xp >= 20) { lvl = 'Platinum'; next = 30; }
  else if (xp >= 15) { lvl = 'Gold'; next = 20; }
  else if (xp >= 10) { lvl = 'Silver'; next = 15; }
  return { level: lvl, nextThreshold: next };
}
