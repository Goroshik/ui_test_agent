/** One UI block extracted from a snapshot by the splitter. */
export interface ComponentBlock {
  blockName: string;  // e.g. "top-navbar", "sidebar-edit", "policy-list"
  content: string;    // accessibility tree lines belonging to this block
}
