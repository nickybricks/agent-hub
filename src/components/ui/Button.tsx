"use client";

import { ButtonHTMLAttributes, forwardRef } from "react";

type Variant = "primary" | "ghost";
type Size = "md" | "sm";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", className = "", ...rest },
  ref
) {
  const v = variant === "primary" ? "btn-primary" : "btn-ghost";
  const s = size === "sm" ? "btn-sm" : "";
  return <button ref={ref} className={`btn ${v} ${s} ${className}`} {...rest} />;
});
