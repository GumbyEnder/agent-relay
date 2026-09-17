/** Civilian board labels. Shop-floor columns stay in Dev Boards. */
export const CIVILIAN_COLUMNS = [
  "Waiting",
  "Working",
  "Needs you",
  "Done",
] as const;

export type CivilianColumn = (typeof CIVILIAN_COLUMNS)[number];

export const SHOP_TO_CIVILIAN: Record<string, CivilianColumn> = {
  inbox: "Waiting",
  ready: "Waiting",
  running: "Working",
  needs_human: "Needs you",
  blocked: "Needs you",
  review: "Done",
  done: "Done",
};
