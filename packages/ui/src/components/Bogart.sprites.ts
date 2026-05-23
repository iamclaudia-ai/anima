// Bogart sprite sheet URLs, kept in their own module so Bogart.tsx exports
// only a component (Fast Refresh / react-doctor `only-export-components`).
// Bun's bundler emits each .png as a hashed asset and resolves these imports
// to URLs (e.g. "/assets/sprite1-<hash>.png") served by the gateway.
import sprite1Url from "../../static/bogart/sprite1.png";
import sprite2Url from "../../static/bogart/sprite2.png";
import sprite3Url from "../../static/bogart/sprite3.png";

/**
 * Bogart sprite sheet URLs, exported so consumers (e.g. the bogart scratchpad
 * page) can reference them without re-importing the binary.
 */
export const BOGART_SPRITE_URLS = [sprite1Url, sprite2Url, sprite3Url] as const;
