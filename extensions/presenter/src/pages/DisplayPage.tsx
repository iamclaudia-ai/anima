/**
 * Display Page — Projector/external screen view
 *
 * Wraps PresenterPage in display mode: listens for sync events
 * from the presenter notes view and follows along passively.
 *
 * URL: /present/:id/display
 */

import { PresenterPage } from "./PresenterPage";

export function DisplayPage({ id }: { id: string }) {
  return <PresenterPage id={id} display />;
}
