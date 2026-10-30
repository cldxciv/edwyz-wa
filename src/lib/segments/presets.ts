import type { Filter } from "./filter";

export const PRESET_PREFIX = "preset:";

export type PresetSegment = { id: string; name: string; description: string; filter: Filter };

const PRESETS: PresetSegment[] = [
  {
    id: `${PRESET_PREFIX}recent`,
    name: "Recently active",
    description: "People who messaged you in the last 30 days.",
    filter: { all: [{ field: "lastInbound", op: "within_days", value: "30" }] },
  },
  {
    id: `${PRESET_PREFIX}winback`,
    name: "Win back",
    description: "People whose last message to you was 30 to 90 days ago.",
    filter: {
      all: [
        { field: "lastInbound", op: "within_days", value: "90" },
        { field: "lastInbound", op: "older_than_days", value: "30" },
      ],
    },
  },
  {
    id: `${PRESET_PREFIX}at_risk`,
    name: "At risk",
    description: "People who have not messaged you in the last 90 days, or never.",
    filter: { all: [{ field: "lastInbound", op: "older_than_days", value: "90" }] },
  },
  {
    id: `${PRESET_PREFIX}new`,
    name: "New this month",
    description: "Contacts you added in the last 30 days.",
    filter: { all: [{ field: "createdAt", op: "within_days", value: "30" }] },
  },
];

export const presetSegments = (): PresetSegment[] => PRESETS;
export const findPreset = (id: string): PresetSegment | undefined => PRESETS.find((p) => p.id === id);
