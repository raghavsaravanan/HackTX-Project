import type { PlayerStats, QuestType, Reward, Sfx } from "../shared/types.ts";

export const XP = {
  step: 20,
  noHint: 10,
  comboPerStep: 5,
  comboCap: 25,
  swift: 10,
  swiftUnderSec: 20,
  quest: { side: 50, boss: 150 } satisfies Record<QuestType, number>,
  flawless: 50,
};

/** Level n starts at 50 * n * (n - 1) XP: 0, 100, 300, 600, 1000, ... */
const levelStart = (level: number) => 50 * level * (level - 1);

export function levelForXp(xp: number): number {
  let level = 1;
  while (xp >= levelStart(level + 1)) level++;
  return level;
}

export function freshStats(): PlayerStats {
  return withLevel({ xp: 0, level: 1, xpIntoLevel: 0, xpForNextLevel: 100, combo: 0, bestCombo: 0, questsCompleted: 0, stepsCompleted: 0 });
}

function withLevel(stats: PlayerStats): PlayerStats {
  const level = levelForXp(stats.xp);
  return {
    ...stats,
    level,
    xpIntoLevel: stats.xp - levelStart(level),
    xpForNextLevel: levelStart(level + 1) - levelStart(level),
  };
}

function apply(stats: PlayerStats, breakdown: Reward["breakdown"], sfx: Sfx[], combo: number): { stats: PlayerStats; reward: Reward } {
  const xpGained = breakdown.reduce((sum, b) => sum + b.xp, 0);
  const next = withLevel({ ...stats, xp: stats.xp + xpGained, combo, bestCombo: Math.max(stats.bestCombo, combo) });
  const leveledUp = next.level > stats.level;
  if (leveledUp) sfx.push("levelup");
  return {
    stats: next,
    reward: { xpGained, breakdown, totalXp: next.xp, level: next.level, leveledUp, combo, sfx },
  };
}

export function rewardStep(stats: PlayerStats, opts: { usedHint: boolean; durationMs: number }) {
  const combo = opts.usedHint ? 0 : stats.combo + 1;
  const breakdown: Reward["breakdown"] = [{ label: "Step complete", xp: XP.step }];
  if (!opts.usedHint) breakdown.push({ label: "No hints", xp: XP.noHint });
  if (combo > 1) breakdown.push({ label: `Combo x${combo}`, xp: Math.min(XP.comboCap, XP.comboPerStep * (combo - 1)) });
  if (opts.durationMs < XP.swiftUnderSec * 1000) breakdown.push({ label: "Swift", xp: XP.swift });

  const sfx: Sfx[] = ["step"];
  if (combo >= 3) sfx.push("combo");
  const result = apply(stats, breakdown, sfx, combo);
  result.stats.stepsCompleted++;
  return result;
}

export function rewardQuest(stats: PlayerStats, opts: { type: QuestType; hintsUsed: number }) {
  const breakdown: Reward["breakdown"] = [{ label: opts.type === "boss" ? "Boss defeated" : "Quest complete", xp: XP.quest[opts.type] }];
  if (opts.hintsUsed === 0) breakdown.push({ label: "Flawless", xp: XP.flawless });
  const result = apply(stats, breakdown, ["quest"], stats.combo);
  result.stats.questsCompleted++;
  return result;
}
