import { create } from "zustand";
import type { LayoutDirection } from "./layout";

/** Presentation-only layout direction. Never saved into the flow document or storage. */
export const useLayoutDirection = create<{
  direction: LayoutDirection;
  setDirection: (direction: LayoutDirection) => void;
}>(set=>({
  direction:"TB",
  setDirection:direction=>set({direction}),
}));
