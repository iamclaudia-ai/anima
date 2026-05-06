import { createContext, useContext, type ReactNode } from "react";

export type ToolVariant = "badge" | "timeline";

const ToolVariantContext = createContext<ToolVariant>("badge");

export function useToolVariant(): ToolVariant {
  return useContext(ToolVariantContext);
}

export function ToolVariantProvider({
  variant,
  children,
}: {
  variant: ToolVariant;
  children: ReactNode;
}) {
  return <ToolVariantContext.Provider value={variant}>{children}</ToolVariantContext.Provider>;
}
