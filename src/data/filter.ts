import type { CraftKind } from "../../shared/craft.js";

const TINY_KINDS: CraftKind[] = ["pleasure", "sailing", "general"];
const TINY_ZOOM = 5;

export function buildIconFilter(visible: Set<CraftKind>): any {
  return [
    "all",
    ["in", ["get", "kind"], ["literal", [...visible]]],
    ["any", [">=", ["zoom"], TINY_ZOOM], ["not", ["in", ["get", "kind"], ["literal", TINY_KINDS]]]],
  ];
}
