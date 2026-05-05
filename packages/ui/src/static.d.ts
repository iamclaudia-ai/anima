/**
 * Ambient module declarations for asset imports.
 *
 * Bun's bundler returns the public URL string for asset imports with the
 * appropriate loader. This tells TypeScript what `import sprite from
 * "./sprite.png"` resolves to (a string URL).
 */

declare module "*.png" {
  const src: string;
  export default src;
}

declare module "*.jpg" {
  const src: string;
  export default src;
}

declare module "*.jpeg" {
  const src: string;
  export default src;
}

declare module "*.gif" {
  const src: string;
  export default src;
}

declare module "*.webp" {
  const src: string;
  export default src;
}

declare module "*.svg" {
  const src: string;
  export default src;
}
