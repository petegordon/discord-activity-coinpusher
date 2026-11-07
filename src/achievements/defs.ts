/**
 * Carnival Dozer achievements, saved to the player's House Tandem account.
 * Shared by the table (toasts), the relay room (worker/src/scorekeeper.ts and
 * src/achievements/referee.ts decide what was earned) and housetandem.com,
 * which reads them from GET /api/achievements.
 */
export type AchievementGroup = "firsts" | "teamwork" | "pushes" | "lifetime";

export type AchievementDef = {
  id: string;
  name: string;
  description: string;
  icon: string;
  group: AchievementGroup;
};

export const ACHIEVEMENTS: readonly AchievementDef[] = [
  { id: "first_drop", name: "First Drop", description: "Drop a coin.", icon: "🪙", group: "firsts" },
  { id: "into_the_tray", name: "Into the Tray", description: "Win a coin back at your chute.", icon: "📥", group: "firsts" },
  { id: "prize_winner", name: "Prize Winner", description: "Knock a prize box into the tray.", icon: "🎁", group: "firsts" },
  { id: "top_prize", name: "Top Prize", description: "Win the 50-point box.", icon: "👑", group: "firsts" },
  { id: "tower_down", name: "Tower Down", description: "Win all four boxes of one tower.", icon: "🏗️", group: "firsts" },

  { id: "in_sync", name: "In Sync", description: "Shake together with another player.", icon: "🤜", group: "teamwork" },
  { id: "full_shake", name: "Full Shake", description: "Shake together with 4 players.", icon: "🫨", group: "teamwork" },
  { id: "tilt", name: "Tilt!", description: "Help set off a tilt lock.", icon: "🚨", group: "teamwork" },
  { id: "steady_hands", name: "Steady Hands", description: "Finish a game with 2 or more players and no tilt lock.", icon: "🧘", group: "teamwork" },

  { id: "jackpot", name: "Jackpot", description: "10 coins into the tray within 1 second.", icon: "💰", group: "pushes" },
  { id: "avalanche", name: "Avalanche", description: "25 coins into the tray within 2 seconds.", icon: "🏔️", group: "pushes" },
  { id: "bank_shot", name: "Bank Shot", description: "A coin you dropped at full left or right aim lands in the tray.", icon: "🎯", group: "pushes" },
  { id: "breaking_even", name: "Breaking Even", description: "Win back as many coins as you started with, in one game.", icon: "⚖️", group: "pushes" },
  { id: "high_score", name: "High Score", description: "Reach a team score of 100 in a game.", icon: "⭐", group: "pushes" },
  { id: "big_night", name: "Big Night", description: "Reach a team score of 250 in a game.", icon: "🎆", group: "pushes" },

  { id: "regular", name: "Regular", description: "Play 25 games.", icon: "🎟️", group: "lifetime" },
  { id: "coin_collector", name: "Coin Collector", description: "Win 1,000 coins.", icon: "🏦", group: "lifetime" },
  { id: "prize_hunter", name: "Prize Hunter", description: "Win 50 prizes.", icon: "🧸", group: "lifetime" },
  { id: "good_company", name: "Good Company", description: "Play with 10 different signed-in people.", icon: "🤝", group: "lifetime" },
  { id: "phone_pusher", name: "Phone Pusher", description: "Drop 25 coins with your phone.", icon: "📱", group: "lifetime" },
];

export const ACHIEVEMENT_BY_ID: ReadonlyMap<string, AchievementDef> = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));
