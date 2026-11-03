/**
 * Eddy's Studio and Canva tools (docs/specs/ADS-MCP-CANVA-CREATIVE-SPEC.md 5.5): list_image_templates, list_library_images and
 * make_brand_image (feature "studio"), and list_canva_designs, import_canva_design, list_canva_templates and fill_canva_template
 * (feature "canva").
 *
 * Empty until MCC-11 fills it. Each definition here names its own feature, "studio" or "canva" (tests/actions-feature-gating
 * checks), so model-tools.ts offers it only while STUDIO_ENABLED=on (and, for Canva, while Canva is configured) and the default
 * toolsets stay as pinned while the flags are off.
 */
import type { AnyActionDef } from "../registry";

export const STUDIO_DEFS: readonly AnyActionDef[] = [];
