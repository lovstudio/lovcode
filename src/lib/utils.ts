import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp', '.tiff', '.avif']);

export function isImageFile(filename: string): boolean {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
  return IMAGE_EXTENSIONS.has(ext);
}

export function getAbsoluteParentPath(path: string): string | undefined {
  const normalized = path.replace(/\\/g, "/");
  if (!normalized.startsWith("/")) return undefined;

  const index = normalized.lastIndexOf("/");
  if (index <= 0) return undefined;

  return normalized.slice(0, index);
}
