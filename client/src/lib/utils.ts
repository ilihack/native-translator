/**
 * Utility function merging Tailwind CSS class names with clsx conditional logic
 * and tailwind-merge deduplication to prevent class conflicts.
 * @exports cn(...inputs) → merged className string
 */
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
