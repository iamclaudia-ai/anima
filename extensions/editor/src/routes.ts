/**
 * Editor Extension — panel declarations.
 *
 * Contributes panels for the IDE layout. No routes of its own —
 * the editor panels are referenced by other extensions' layouts.
 */

import type { PanelDefinition } from "@anima/shared";
import type { ExtensionWebContribution } from "@anima/ui";
import { EditorPanel } from "./panels/EditorPanel";

export const editorPanels: (PanelDefinition & { component: React.ComponentType })[] = [
  // `renderer: "always"` keeps the iframe mounted across tab switches —
  // critical for code-server, which loses session state on unmount.
  {
    id: "editor.viewer",
    title: "Editor",
    icon: "Code",
    renderer: "always",
    component: EditorPanel,
  },
];

// No routes — editor panels are embedded in other extensions' layouts
export const editorRoutes: never[] = [];

export default {
  id: "editor",
  name: "Editor",
  order: 80,
  enabled: false,
  routes: editorRoutes,
  panels: editorPanels,
} satisfies ExtensionWebContribution;
