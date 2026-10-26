import { create } from "zustand";
import type { XYPosition } from "@xyflow/react";

export type AddStepIntent = {
  x: number;
  y: number;
  source?: string;
  port?: string;
  position?: XYPosition;
};

export const useAddStepMenu = create<{
  request: AddStepIntent | null;
  open: (request: AddStepIntent) => void;
  close: () => void;
}>(set=>({
  request:null,
  open:request=>set({request}),
  close:()=>set({request:null}),
}));
