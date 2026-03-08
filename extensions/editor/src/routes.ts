/**
 * Editor Extension — panel declarations.
 *
 * Contributes panels for the IDE layout. No routes of its own —
 * the editor panels are referenced by other extensions' layouts.
 */

import type { PanelDefinition } from "@claudia/shared";
import { EditorPanel } from "./panels/EditorPanel";

export const editorPanels: (PanelDefinition & { component: React.ComponentType })[] = [
  { id: "editor.viewer", title: "Editor", icon: "Code", component: EditorPanel },
];

// No routes — editor panels are embedded in other extensions' layouts
export const editorRoutes: never[] = [];
